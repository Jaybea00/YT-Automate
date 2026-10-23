import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import type { ShotPlan } from '@/lib/script/generate-script';
import { renderMotionClip, FPS } from './motion/frame-renderer';
import { escapeHtml, themedPage } from './motion/templates';
import type { MotionTheme } from './motion/theme';
import { photoForRender } from './annotated-photo';
import { resolveOfficialUrl } from './screen-recording-step';
import type { ShotRenderContext, TypedShotRenderer } from './shot-renderers';

/**
 * "Screen recording" shots: the real website a beat names, shown in a browser window that scrolls
 * smoothly down the page. The page is loaded fully, cookie banners are dismissed, and one sharp
 * full-page screenshot is animated (recording the live page gave blurry video that often opened
 * on a blank or half-loaded page). One capture per URL is reused across shots.
 */

const CAPTURE_WIDTH = 1920;
/** Long pages are cut here: a shot only ever scrolls through the top of a page. */
const MAX_CAPTURE_HEIGHT = 3600;
const BLOCKED_TITLE = /access denied|just a moment|security check|attention required|cloudflare|captcha|verify you are human/i;
const ACCEPT_TEXT = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|i agree|agree( and (continue|close))?|got it|ok(ay)?|consent|continue)$/i;

/** A URL the shot names directly ("stripe.com/docs", "https://react.dev"), or null. */
export function urlFromQuery(query: string): string | null {
  const m = query.trim().match(/^(https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s]*)?$/i);
  if (!m) return null;
  return `https://${m[2].toLowerCase()}${m[3] ?? ''}`;
}

export const domainOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');

/** Clicks the consent button of a cookie banner if there is one, and hides what's left of it. */
async function clearBanners(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    const buttons = frame.locator('button, [role="button"], a');
    const count = Math.min(await buttons.count().catch(() => 0), 80);
    for (let i = 0; i < count; i++) {
      const b = buttons.nth(i);
      const text = ((await b.innerText({ timeout: 300 }).catch(() => '')) || '').trim();
      if (text && text.length <= 40 && ACCEPT_TEXT.test(text) && (await b.isVisible().catch(() => false))) {
        await b.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(400);
        break;
      }
    }
  }
  // Interstitial ads and modals: their close button
  const closers = page.locator('[aria-label*="close" i], [aria-label*="dismiss" i], [title*="close" i], button:has-text("×"), button:has-text("✕")');
  const closeCount = Math.min(await closers.count().catch(() => 0), 10);
  for (let i = 0; i < closeCount; i++) {
    const c = closers.nth(i);
    if (await c.isVisible().catch(() => false)) await c.click({ timeout: 1000 }).catch(() => {});
  }
  // Whatever consent overlay remains (and sticky chat or promo bars) would cover the page
  await page
    .evaluate(() => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const id = `${el.id} ${el.className}`.toLowerCase();
        const style = getComputedStyle(el);
        const covering = style.position === 'fixed' || style.position === 'sticky';
        if (covering && /cookie|consent|gdpr|onetrust|cmp|banner|newsletter|intercom|chat-widget|drift/.test(id)) {
          el.style.display = 'none';
          continue;
        }
        // Big overlays (takeovers, modals) cover the page whatever they're called
        const box = el.getBoundingClientRect();
        const layered = style.position === 'absolute' && Number(style.zIndex) >= 1000;
        if ((covering || layered) && box.width * box.height > window.innerWidth * window.innerHeight * 0.4) {
          el.style.display = 'none';
          continue;
        }
        // Ad and sponsor slots: a viewer should see the site, not its advertisers
        if (/(^|[\s_-])(ad|ads|advert|advertisement|adslot|ad-slot|dotcom-ad|sponsor(ed)?|leaderboard|billboard|takeover|interstitial)([\s_-]|$)/.test(id)) {
          el.style.display = 'none';
        }
      }
      for (const frame of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'))) {
        if (/doubleclick|googlesyndication|adservice|amazon-adsystem|criteo|taboola|outbrain/.test(frame.src)) frame.style.display = 'none';
      }
    })
    .catch(() => {});
}

/**
 * The top of the page as one screenshot (cached per URL). Throws when the page can't be shown:
 * an error status, a bot check, or an empty page.
 */
export async function capturePage(url: string, outDir: string, browser?: Browser): Promise<{ file: string; height: number }> {
  await fs.mkdir(outDir, { recursive: true });
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const file = path.join(outDir, `screen_${key}.png`);
  const meta = `${file}.json`;
  const cached = await fs.readFile(meta, 'utf-8').then((t) => JSON.parse(t) as { height: number }).catch(() => null);
  if (cached && (await fs.stat(file).catch(() => null))) return { file, height: cached.height };

  const own = !browser;
  const b = browser ?? (await chromium.launch({ headless: true }));
  const context = await b.newContext({
    viewport: { width: CAPTURE_WIDTH, height: 1080 },
    deviceScaleFactor: 1,
    locale: 'en-GB',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (!response || response.status() >= 400) throw new Error(`HTTP ${response?.status() ?? 'no response'} for ${url}`);
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    const title = await page.title().catch(() => '');
    if (BLOCKED_TITLE.test(title)) throw new Error(`${domainOf(url)} blocks automated visits ("${title.slice(0, 60)}")`);
    await clearBanners(page);
    // Lazy images below the fold load as the page is scrolled, then back to the top
    await page.evaluate(async (max) => {
      for (let y = 0; y < Math.min(document.body.scrollHeight, max); y += 700) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    }, MAX_CAPTURE_HEIGHT).catch(() => {});
    // Images the scroll pass woke up finish loading; late overlays get cleared again
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(500);
    await clearBanners(page);
    const textLength = await page.evaluate(() => document.body?.innerText.trim().length ?? 0).catch(() => 0);
    if (textLength < 40) throw new Error(`${domainOf(url)} showed an empty page`);
    const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 1080);
    const height = Math.max(1080, Math.min(MAX_CAPTURE_HEIGHT, fullHeight));
    await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: CAPTURE_WIDTH, height } });
    await fs.writeFile(meta, JSON.stringify({ url, height, title }), 'utf-8');
    return { file, height };
  } finally {
    await context.close().catch(() => {});
    if (own) await b.close().catch(() => {});
  }
}

/** Browser window size inside the 1920x1080 frame. */
const WIN_W = 1600;
const WIN_H = 900;
const BAR_H = 56;

/**
 * The page in a browser window: the window settles in and holds on the top of the page (the part
 * people recognise), then scrolls smoothly down at most about one screen while the camera eases in.
 */
export function browserScrollTemplate(theme: MotionTheme, imageUrl: string, imageWidth: number, imageHeight: number, domain: string): string {
  const shownHeight = (imageHeight * WIN_W) / imageWidth;
  const viewH = WIN_H - BAR_H;
  const scroll = Math.max(0, Math.min(shownHeight - viewH, viewH * 0.9));
  return themedPage(
    theme,
    `.win{position:absolute;left:${(1920 - WIN_W) / 2}px;top:${(1080 - WIN_H) / 2}px;width:${WIN_W}px;height:${WIN_H}px;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 30px 80px rgba(0,0,0,.45);border-top:4px solid ${theme.accent};opacity:0}
.bar{height:${BAR_H}px;background:#f1f3f5;border-bottom:1px solid #dde1e5;display:flex;align-items:center;gap:10px;padding:0 20px}
.dot{width:14px;height:14px;border-radius:50%}
.url{margin-left:24px;flex:1;max-width:760px;height:34px;border-radius:17px;background:#fff;border:1px solid #dde1e5;display:flex;align-items:center;gap:10px;padding:0 16px;font:500 17px/1 ${theme.bodyFont};color:#3c4043}
.lock{width:12px;height:14px;border:2px solid #5f6368;border-radius:3px;position:relative}
.view{position:relative;height:${viewH}px;overflow:hidden}
.page{position:absolute;left:0;top:0;width:${WIN_W}px}`,
    `<div class="win" id="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><div class="url"><span class="lock"></span>${escapeHtml(domain)}</div></div><div class="view"><img class="page" id="page" src="${imageUrl}"></div></div>`,
    `const scroll=${scroll.toFixed(1)};window.__frame=(t,d)=>{const intro=ease(phase(t,0,0.5));const w=document.getElementById('win');w.style.opacity=intro;w.style.transform='translateY('+(30*(1-intro))+'px) scale('+(1+0.035*ease(phase(t,0.2,Math.max(0.5,d-0.2))))+')';
document.getElementById('page').style.transform='translateY('+(-scroll*ease(phase(t,d*0.35,Math.max(0.5,d*0.6))))+'px)'};`,
  );
}

/** The shot renderer: resolve the site, capture it, animate it. Failing throws, so the shot falls back to footage. */
export const renderScreenRecording: TypedShotRenderer = async (shot: ShotPlan, slot, clipPath, ctx: ShotRenderContext) => {
  let url = urlFromQuery(shot.visual_query);
  if (!url) {
    if (!ctx.llmProvider || !ctx.llmCtx) throw new Error('no URL in the shot and no model to find one');
    const resolved = await resolveOfficialUrl({ visualQuery: shot.visual_query, text: shot.covers, beatIndex: ctx.beatIndex }, ctx.llmProvider, ctx.llmCtx);
    if (!resolved.resolved || !resolved.url) throw new Error(`no official site found for "${shot.visual_query}"`);
    url = resolved.url;
  }
  const capture = await capturePage(url, ctx.downloadDir, ctx.browser);
  const photo = await photoForRender(capture.file);
  await renderMotionClip({
    html: browserScrollTemplate(ctx.theme, photo.imageUrl, photo.width, photo.height, domainOf(url)),
    durationSec: slot.frames / FPS,
    outputPath: clipPath,
    browser: ctx.browser,
  });
  return {
    clipPath,
    renderedType: 'screen_recording',
    license: 'own_work',
    licenseSource: 'screen_capture',
    attribution: `Screenshot of ${domainOf(url)}`,
    sourceUrl: url,
    note: `screen capture of ${url}`,
  };
};
