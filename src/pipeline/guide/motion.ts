import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { getFfmpegPath } from '../utils/ffmpeg';
import { cropFor, FPS, SHORT_H, SHORT_W } from './timeline';
import type { FootageInfo, GuideShot } from './types';

const execFileAsync = promisify(execFile);

/**
 * Motion graphics from gta-components (assets/gta-components, MIT): the WASTED sting, a location
 * card, a clip shown as a social post. Each component is a web page with one GSAP timeline; it's
 * stepped frame by frame in a headless browser with a transparent background, and the frames become
 * an overlay video (PNG in MOV, with alpha) laid over the guide at its moment. Only a page's CONFIG
 * (its words, numbers and timing) changes; GSAP comes from the app's own package, not the internet.
 */

export type MotionKind = 'wasted' | 'location' | 'social';

export const MOTION_COMPONENTS: Record<MotionKind, string> = {
  wasted: '09-wasted-stamp',
  location: '12-location-card',
  social: '33-social-frame',
};

/** What to render: a component, its variant, CONFIG changes, and clips for its video players. */
export interface MotionRequest {
  kind: MotionKind;
  variant?: string;
  /** Draw the component's own background (a social post's blurred copy of its clip) instead of a transparent one. */
  plate?: boolean;
  /** Merged into the page's CONFIG (objects merge, anything else replaces). */
  config?: Record<string, unknown>;
  durationSec: number;
  /** A clip of ours for the page's own video players (by id), from this point of the clip on. */
  media?: { ids: string[]; file: string };
}

/** The social frame's video players for its Reel variant (post copies and their blurred world copies). */
export const SOCIAL_PLAYERS = ['p0a', 'p0b', 'p0c', 'p0d', 'w0a', 'w0b', 'w0c', 'w0d'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** Objects merged key by key; anything else from `over` replaces. */
export function mergeConfig(base: Obj, over?: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = isObj(v) && isObj(out[k]) ? mergeConfig(out[k] as Obj, v) : v;
  return out;
}

/**
 * Each kind's timing fitted to how long it shows here (the components are made for 5 s on their
 * own), with the guide's changes on top. WASTED lands on its first frames, the place name almost as
 * fast, and both clear just before their end rather than shutting to black.
 */
export function motionConfig(kind: MotionKind, durationSec: number, config?: Obj): Obj {
  const d = durationSec;
  const r = (n: number) => Number(n.toFixed(2));
  const base: Obj =
    kind === 'wasted'
      ? {
          variants: { '0': { kicker: null } },
          timing: { hit: 0.12, stripLead: 0.06, drain: 0.3, meta: 0.4, rule: 0.5, sheen: r(Math.min(0.8, d * 0.35)), sheenDur: 0.7, out: r(d - 0.45), close: r(d + 0.05), closeDur: 0.3, end: r(d + 0.35) },
        }
      : kind === 'location'
        ? { timing: { end0: r(d), cuts0: [0.35, r(d * 0.45), r(d * 0.72)], heroIn: 0.05, out0: r(d - 0.4) } }
        : {};
  return mergeConfig(base, config);
}

const assetsRoot = () => path.join(/* turbopackIgnore: true */ process.cwd(), 'assets', 'gta-components');
const gsapFile = () => path.join(/* turbopackIgnore: true */ process.cwd(), 'node_modules', 'gsap', 'dist', 'gsap.min.js');

/** Where the object literal starting at `open` (a "{") ends, skipping strings and comments. */
export function objectEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
      if (i <= 0) return -1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The page with its CONFIG passed through our changes (window.__gcMerge, set before the page runs)
 * and the named video players pointed at our clip, each starting where its slot of the timeline does
 * (so one continuous clip plays through all of them).
 */
export function patchComponent(html: string, media?: { ids: string[]; src: string }): string {
  const at = html.indexOf('const CONFIG = {');
  if (at < 0) throw new Error('The component has no CONFIG');
  const open = html.indexOf('{', at);
  const close = objectEnd(html, open);
  if (close < 0) throw new Error("The component's CONFIG doesn't close");
  let out = `${html.slice(0, open)}window.__gcMerge(${html.slice(open, close + 1)}, window.__gcOverride || {})${html.slice(close + 1)}`;
  for (const id of media?.ids ?? []) {
    out = out.replace(new RegExp(`<video id="${id}"([^>]*)>`), (_m, attrs: string) => {
      const start = attrs.match(/data-start="([\d.]+)"/)?.[1] ?? '0';
      const next = attrs.replace(/src="[^"]*"/, `src="${media!.src}"`).replace(/data-media-start="[\d.]+"/, `data-media-start="${start}"`);
      return `<video id="${id}"${next}>`;
    });
  }
  return out;
}

/** Deep merge for CONFIG changes, as it runs in the page. */
const MERGE_SCRIPT = `window.__gcMerge = function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  var out = (base && typeof base === 'object' && !Array.isArray(base)) ? Object.assign({}, base) : {};
  Object.keys(over).forEach(function (k) { out[k] = merge(out[k], over[k]); });
  return out;
};`;

/** What runs in the page before its own scripts: the merge, the variables (transparent background) and our CONFIG changes. */
export function initScript(req: Pick<MotionRequest, 'variant' | 'config' | 'plate'>): string {
  const vars = { variant: req.variant ?? '0', bg: req.plate ? 'plate' : 'none' };
  return `${MERGE_SCRIPT}
window.__hyperframes = { getVariables: function () { return ${JSON.stringify(vars)}; } };
window.__gcOverride = ${JSON.stringify(req.config ?? {})};`;
}

/** A clip cut for a component's video player: our framing, vertical, as WebM (the browser can't play H.264). */
export async function prepareMotionClip(src: string, info: FootageInfo, shot: GuideShot, durationSec: number, out: string): Promise<void> {
  const crop = cropFor(info, shot.focusX, shot.zoom, shot.focusY);
  await execFileAsync(getFfmpegPath(), [
    '-y', '-v', 'error', '-ss', shot.from.toFixed(3), '-t', durationSec.toFixed(3), '-i', src,
    '-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${SHORT_W}:${SHORT_H}:flags=lanczos,fps=${FPS},setsar=1`,
    '-an', '-c:v', 'libvpx-vp9', '-b:v', '6M', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', out,
  ], { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
}

/** Renders a component to an overlay video inside `dir` (kept, and reused while nothing about it changes). */
export async function renderMotion(dir: string, req: MotionRequest): Promise<string> {
  const component = path.join(assetsRoot(), 'shorts', MOTION_COMPONENTS[req.kind]);
  const html = await fs.readFile(path.join(component, 'index.html'), 'utf-8');
  const mediaStat = req.media ? await fs.stat(req.media.file) : null;
  const key = createHash('sha1')
    .update(JSON.stringify({ req: { ...req, media: req.media ? { ...req.media, mtime: mediaStat?.mtimeMs, size: mediaStat?.size } : null }, html: createHash('sha1').update(html).digest('hex') }))
    .digest('hex')
    .slice(0, 12);
  const rel = path.join('motion', `${req.kind}-${key}.mov`);
  const out = path.join(dir, rel);
  if (await fs.stat(out).then((s) => s.size > 0).catch(() => false)) return rel;

  // A working copy of the page beside the shared fonts and look/motion kit it loads from assets/
  const work = path.join(dir, 'motion', `work-${key}`);
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(path.join(work, 'assets', 'shots'), { recursive: true });
  await fs.mkdir(path.join(work, 'frames'), { recursive: true });
  await fs.cp(path.join(assetsRoot(), 'shared', 'fonts'), path.join(work, 'assets', 'fonts'), { recursive: true });
  await fs.cp(path.join(assetsRoot(), 'shared', 'kit-shorts'), path.join(work, 'assets', 'kit'), { recursive: true });
  let media: { ids: string[]; src: string } | undefined;
  if (req.media) {
    await fs.copyFile(req.media.file, path.join(work, 'assets', 'shots', 'ours.webm'));
    media = { ids: req.media.ids, src: 'assets/shots/ours.webm' };
  }
  await fs.writeFile(path.join(work, 'index.html'), patchComponent(html, media), 'utf-8');

  const frames = Math.max(1, Math.round(req.durationSec * FPS));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: SHORT_W, height: SHORT_H }, deviceScaleFactor: 1 });
    // GSAP from the app's own copy; nothing else leaves the computer
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (/\/gsap(@[\d.]+)?\/dist\/gsap\.min\.js$/.test(url)) return route.fulfill({ path: gsapFile(), contentType: 'application/javascript' });
      if (url.startsWith('file:')) return route.continue();
      return route.abort();
    });
    // Given as text: a function would be sent with the TypeScript runner's helpers, which the page doesn't have
    await page.addInitScript({ content: initScript(req) });
    await page.goto(pathToFileURL(path.join(work, 'index.html')).href, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as unknown as { __timelines?: { main?: unknown } }).__timelines?.main, null, { timeout: 15_000 });
    const ready = await page.evaluate(() => {
      const w = window as unknown as { __hyperframes?: { getVariables: () => { bg?: string } }; __gcOverride?: unknown };
      return !!w.__hyperframes?.getVariables().bg && !!w.__gcOverride;
    });
    if (!ready) throw new Error(`The ${req.kind} graphic didn't take its settings`);
    await page.evaluate(async () => {
      await document.fonts.ready;
      // Every video player the page kept: wait until it can show a frame
      const vids = [...document.querySelectorAll('video')].filter((v) => v.style.display !== 'none');
      await Promise.all(
        vids.map((v) => (v.readyState >= 2 ? null : new Promise<void>((ok) => { v.addEventListener('loadeddata', () => ok(), { once: true }); v.addEventListener('error', () => ok(), { once: true }); setTimeout(ok, 8000); }))),
      );
    });
    for (let f = 0; f < frames; f++) {
      const t = f / FPS;
      await page.evaluate(async (t) => {
        // As the HyperFrames player does: a clip shows during its slot, its video at its own point
        const seeks: Promise<void>[] = [];
        for (const el of [...document.querySelectorAll<HTMLElement>('.clip[data-start]')]) {
          const start = Number(el.dataset.start ?? 0);
          const dur = Number(el.dataset.duration ?? 1e9);
          const on = t >= start && t < start + dur;
          el.style.visibility = on ? 'visible' : 'hidden';
          if (on && el instanceof HTMLVideoElement && el.style.display !== 'none') {
            const want = Number(el.dataset.mediaStart ?? 0) + (t - start);
            if (Math.abs(el.currentTime - want) > 0.001) {
              seeks.push(new Promise<void>((ok) => { el.addEventListener('seeked', () => ok(), { once: true }); setTimeout(ok, 3000); }));
              el.currentTime = want;
            }
          }
        }
        await Promise.all(seeks);
        (window as unknown as { __timelines: { main: { seek: (t: number, s: boolean) => void } } }).__timelines.main.seek(t, false);
      }, t);
      await page.screenshot({ path: path.join(work, 'frames', `f${String(f).padStart(4, '0')}.png`), omitBackground: true });
    }
  } finally {
    await browser.close();
  }
  await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-framerate', String(FPS), '-i', path.join(work, 'frames', 'f%04d.png'), '-c:v', 'png', '-pix_fmt', 'rgba', out], { timeout: 10 * 60_000 });
  await fs.rm(work, { recursive: true, force: true });
  return rel;
}
