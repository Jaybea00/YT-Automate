import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import type { ShotPlan } from '@/lib/script/generate-script';
import { getFfmpegPath } from '../utils/ffmpeg';
import { ENCODE } from './clips';
import { motionDocument, FRAME_HEIGHT, FRAME_WIDTH } from './motion/frame-renderer';
import { escapeHtml } from './motion/templates';
import type { MotionTheme } from './motion/theme';
import { summarizeLicenses, type RenderedShot } from './shot-composer';
import { renderFootageShot, type TypedShotRenderer } from './shot-renderers';

const execFileAsync = promisify(execFile);

/**
 * Split-screen and photo grids: two to four pictures side by side (then and now, two rivals,
 * several people at once). Each panel is found and checked like any footage shot, then the
 * panels are cropped into place and labelled in the style's look.
 */

const GAP = 6;

export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where each panel goes: two side by side, three columns, or a 2x2 grid. */
export function splitLayout(n: number, width = FRAME_WIDTH, height = FRAME_HEIGHT): PanelRect[] {
  const even = (v: number) => Math.floor(v / 2) * 2;
  if (n === 4) {
    const w = even((width - GAP) / 2);
    const h = even((height - GAP) / 2);
    return [
      { x: 0, y: 0, w, h },
      { x: width - w, y: 0, w, h },
      { x: 0, y: height - h, w, h },
      { x: width - w, y: height - h, w, h },
    ];
  }
  const cols = Math.max(2, Math.min(3, n));
  const w = even((width - GAP * (cols - 1)) / cols);
  return Array.from({ length: cols }, (_, i) => ({ x: i === cols - 1 ? width - w : i * (w + GAP), y: 0, w, h: height }));
}

/** The labels, title and (for a pair) the "VS" badge, as a transparent page laid over the panels. */
export function splitOverlayDocument(theme: MotionTheme, spec: NonNullable<ShotPlan['split']>, rects: PanelRect[]): string {
  const labels = spec.panels
    .map((p, i) => {
      if (!p.label) return '';
      const r = rects[i];
      return `<div class="lab" style="left:${r.x + 28}px;top:${r.y + r.h - 28}px">${escapeHtml(p.label)}</div>`;
    })
    .join('');
  const vs = rects.length === 2 ? `<div class="vs" style="left:${FRAME_WIDTH / 2}px;top:${FRAME_HEIGHT / 2}px">VS</div>` : '';
  const title = spec.title ? `<div class="title">${escapeHtml(spec.title)}</div>` : '';
  return motionDocument({
    css: `html,body{background:transparent}
.lab{position:absolute;transform:translateY(-100%);font:700 ${rects.length === 4 ? 36 : 42}px ${theme.headingFont};color:#fbf8f1;background:rgba(10,10,12,.78);border-left:8px solid ${theme.accent};padding:10px 20px;border-radius:4px;white-space:nowrap;max-width:${Math.min(...rects.map((r) => r.w)) - 56}px;overflow:hidden;text-overflow:ellipsis}
.vs{position:absolute;transform:translate(-50%,-50%);width:120px;height:120px;border-radius:50%;background:${theme.accent};color:#fff;font:900 46px ${theme.headingFont};display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.title{position:absolute;left:50%;top:44px;transform:translateX(-50%);font:800 52px ${theme.headingFont};color:#fbf8f1;background:rgba(10,10,12,.78);padding:12px 32px;border-radius:6px;white-space:nowrap}`,
    body: `${labels}${vs}${title}`,
    script: '',
  });
}

async function renderOverlay(theme: MotionTheme, spec: NonNullable<ShotPlan['split']>, rects: PanelRect[], file: string, browser?: import('playwright').Browser): Promise<void> {
  const own = browser ? null : await chromium.launch({ headless: true });
  const b = browser ?? own!;
  const page = await b.newPage({ viewport: { width: FRAME_WIDTH, height: FRAME_HEIGHT } });
  try {
    await page.setContent(splitOverlayDocument(theme, spec, rects), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    await page.screenshot({ path: file, omitBackground: true });
  } finally {
    await page.close().catch(() => {});
    await own?.close().catch(() => {});
  }
}

/** The panels cropped into their places over a dark gutter, with the overlay on top. */
export async function composeSplit(panelClips: string[], overlayPng: string, rects: PanelRect[], frames: number, out: string): Promise<void> {
  const n = panelClips.length;
  const parts = panelClips.map((_, i) => `[${i}:v]scale=${rects[i].w}:${rects[i].h}:force_original_aspect_ratio=increase,crop=${rects[i].w}:${rects[i].h},setsar=1[p${i}]`);
  let last = 'bg';
  parts.push(`color=c=0x0b0b0d:s=${FRAME_WIDTH}x${FRAME_HEIGHT}:r=30[bg]`);
  rects.forEach((r, i) => {
    parts.push(`[${last}][p${i}]overlay=${r.x}:${r.y}:shortest=1[s${i}]`);
    last = `s${i}`;
  });
  parts.push(`[${last}][${n}:v]overlay=0:0,scale=out_range=tv,format=yuv420p[v]`);
  await execFileAsync(getFfmpegPath(), [
    '-y', '-v', 'error',
    ...panelClips.flatMap((c) => ['-i', c]),
    '-loop', '1', '-i', overlayPng,
    '-filter_complex', parts.join(';'),
    '-map', '[v]', '-frames:v', String(frames), ...ENCODE, out,
  ]);
}

export const renderSplitShot: TypedShotRenderer = async (shot, slot, clipPath, ctx) => {
  const spec = shot.split;
  if (!spec || spec.panels.length < 2) throw new Error('split shot has no panels');
  const panels = spec.panels.slice(0, 4);
  const rects = splitLayout(panels.length);
  const dir = `${clipPath}.panels`;
  await fs.mkdir(dir, { recursive: true });
  try {
    const rendered: RenderedShot[] = [];
    for (const [i, p] of panels.entries()) {
      // Each panel is a footage shot of its own (no caption: the label names it)
      const panelShot: ShotPlan = { ...shot, visual_type: p.archive ? 'archive' : 'stock', visual_query: p.query, caption: undefined, annotation: undefined, split: undefined };
      rendered.push(await renderFootageShot(panelShot, { ...slot, shot: panelShot }, path.join(dir, `panel_${i}.mp4`), ctx, { note: `split panel ${i + 1}` }));
    }
    const overlay = path.join(dir, 'overlay.png');
    await renderOverlay(ctx.theme, { ...spec, panels }, rects, overlay, ctx.browser);
    await composeSplit(rendered.map((r) => r.clipPath), overlay, rects, slot.frames, clipPath);
    const { license, attribution, sources } = summarizeLicenses(rendered);
    return {
      clipPath,
      renderedType: 'split',
      license,
      licenseSource: `${rendered.length} panels`,
      attribution,
      sourceUrl: sources[0] ?? null,
      note: `split: ${panels.map((p) => p.label || p.query).join(' | ')}`,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};
