import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright';
import type { LLMProvider, ProviderCallContext } from '../providers/types';
import { getFfmpegPath } from '../utils/ffmpeg';
import { locateTarget, type Annotation, type TargetBox } from './annotated-photo';
import { ENCODE } from './clips';
import { motionDocument, FPS, FRAME_HEIGHT, FRAME_WIDTH } from './motion/frame-renderer';
import { escapeHtml } from './motion/templates';
import type { MotionTheme } from './motion/theme';

const execFileAsync = promisify(execFile);

/**
 * Labels that follow moving footage: the vision model finds the subject in the clip's first
 * frame, it is tracked through the clip by matching its look frame to frame, and a ring with
 * its label rides along with it. If the subject is lost (it leaves the frame or is hidden), the
 * label fades out rather than pointing at the wrong thing.
 */

/** Tracking resolution: small enough to be quick on a laptop, large enough to follow a person. */
const TRACK_W = 320;
const TRACK_H = 180;
/** How far the subject may move between frames, in tracking pixels. */
const SEARCH = 10;
/** Below this match quality the subject is taken to be lost. */
const LOST_SCORE = 0.45;
/** Frames in a row below LOST_SCORE before the label leaves. */
const LOST_FRAMES = 4;
/** Templates are kept to about this many pixels across, for speed. */
const MAX_TEMPLATE = 36;

export interface TrackPoint {
  /** Centre of the subject, in output pixels. */
  x: number;
  y: number;
}

/** Normalised cross-correlation of a template against a window of a frame (1 = identical). */
function ncc(frame: Uint8Array, fw: number, tpl: Float32Array, tw: number, th: number, ox: number, oy: number, tMean: number, tStd: number): number {
  let sum = 0;
  let sum2 = 0;
  let cross = 0;
  const n = tw * th;
  for (let y = 0; y < th; y++) {
    const row = (oy + y) * fw + ox;
    for (let x = 0; x < tw; x++) {
      const v = frame[row + x];
      sum += v;
      sum2 += v * v;
      cross += v * tpl[y * tw + x];
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(1e-6, sum2 / n - mean * mean));
  return (cross / n - mean * tMean) / (std * tStd);
}

/**
 * Follows a subject through grey frames (TRACK_W x TRACK_H, frames back to back) from its box in
 * the first frame. Returns its centre per frame (tracking pixels), null once it is lost.
 */
export function trackTarget(frames: Uint8Array[], box: { x: number; y: number; w: number; h: number }, fw = TRACK_W, fh = TRACK_H): Array<{ x: number; y: number } | null> {
  // Track on a smaller template when the subject is big
  const step = Math.max(1, Math.ceil(Math.max(box.w, box.h) / MAX_TEMPLATE));
  const tw = Math.max(4, Math.floor(box.w / step));
  const th = Math.max(4, Math.floor(box.h / step));
  const sw = Math.floor(fw / step);
  const sh = Math.floor(fh / step);
  const shrink = (f: Uint8Array) => {
    if (step === 1) return f;
    const out = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) out[y * sw + x] = f[y * step * fw + x * step];
    return out;
  };
  const first = shrink(frames[0]);
  let px = Math.max(0, Math.min(sw - tw, Math.round(box.x / step)));
  let py = Math.max(0, Math.min(sh - th, Math.round(box.y / step)));
  const tpl = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) tpl[y * tw + x] = first[(py + y) * sw + px + x];
  const stats = () => {
    let s = 0;
    let s2 = 0;
    for (const v of tpl) {
      s += v;
      s2 += v * v;
    }
    const m = s / tpl.length;
    return { mean: m, std: Math.sqrt(Math.max(1e-6, s2 / tpl.length - m * m)) };
  };
  let { mean, std } = stats();
  if (std < 4) return frames.map((_, i) => (i === 0 ? { x: (px + tw / 2) * step, y: (py + th / 2) * step } : null));

  const out: Array<{ x: number; y: number } | null> = [{ x: (px + tw / 2) * step, y: (py + th / 2) * step }];
  let misses = 0;
  const reach = Math.max(2, Math.round(SEARCH / step));
  for (let i = 1; i < frames.length; i++) {
    const f = shrink(frames[i]);
    let best = -2;
    let bx = px;
    let by = py;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x + tw > sw || y + th > sh) continue;
        const score = ncc(f, sw, tpl, tw, th, x, y, mean, std);
        if (score > best) {
          best = score;
          bx = x;
          by = y;
        }
      }
    }
    if (best < LOST_SCORE) {
      misses++;
      if (misses >= LOST_FRAMES) {
        while (out.length < frames.length) out.push(null);
        break;
      }
      out.push(out[out.length - 1]);
      continue;
    }
    misses = 0;
    px = bx;
    py = by;
    // Let the template drift slowly with the subject's changing look
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) tpl[y * tw + x] = tpl[y * tw + x] * 0.9 + f[(py + y) * sw + px + x] * 0.1;
    ({ mean, std } = stats());
    out.push({ x: (px + tw / 2) * step, y: (py + th / 2) * step });
  }
  return out;
}

/** The path smoothed over a few frames, so the ring glides instead of jittering. */
export function smoothTrack(points: Array<{ x: number; y: number } | null>, radius = 3): Array<{ x: number; y: number } | null> {
  return points.map((p, i) => {
    if (!p) return null;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      const q = points[j];
      if (q) {
        sx += q.x;
        sy += q.y;
        n++;
      }
    }
    return { x: sx / n, y: sy / n };
  });
}

/** The ring and label artwork; the ring's centre sits at `anchor` within the image. */
export function trackedLabelDocument(theme: MotionTheme, annotation: Annotation, ringPx: number, labelRight: boolean): { html: string; width: number; height: number; anchor: { x: number; y: number } } {
  const r = Math.round(ringPx / 2);
  const lead = 70;
  const labelW = 560;
  const width = r * 2 + lead + labelW + 40;
  const height = Math.max(r * 2 + 40, 200);
  const cx = labelRight ? r + 20 : width - r - 20;
  const cy = height / 2;
  const lineTo = labelRight ? cx + r + lead : cx - r - lead;
  const labelCss = labelRight ? `left:${lineTo}px` : `right:${width - lineTo}px`;
  const html = motionDocument({
    css: `html,body{width:${width}px;height:${height}px;background:transparent}svg{position:absolute;inset:0}
.l{position:absolute;top:${cy}px;${labelCss};transform:translateY(-50%);font:800 38px ${theme.headingFont};color:#fbf8f1;background:rgba(10,10,12,.82);border-left:8px solid ${theme.accent};padding:10px 22px;border-radius:5px;white-space:nowrap;box-shadow:0 10px 26px rgba(0,0,0,.45)}
.l small{display:block;font:500 24px ${theme.bodyFont};opacity:.85;margin-top:4px}`,
    body: `<svg width="${width}" height="${height}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${theme.accent}" stroke-width="7"/><line x1="${labelRight ? cx + r : cx - r}" y1="${cy}" x2="${lineTo}" y2="${cy}" stroke="#fbf8f1" stroke-width="4"/></svg><div class="l">${escapeHtml(annotation.label)}${annotation.detail ? `<small>${escapeHtml(annotation.detail)}</small>` : ''}</div>`,
    script: '',
  });
  return { html, width, height, anchor: { x: cx, y: cy } };
}

async function greyFrames(clipPath: string): Promise<Uint8Array[]> {
  const { stdout } = await execFileAsync(
    getFfmpegPath(),
    ['-v', 'error', '-i', clipPath, '-vf', `scale=${TRACK_W}:${TRACK_H},format=gray`, '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
  );
  const size = TRACK_W * TRACK_H;
  const frames: Uint8Array[] = [];
  for (let i = 0; i + size <= stdout.length; i += size) frames.push(new Uint8Array(stdout.buffer, stdout.byteOffset + i, size));
  return frames;
}

/**
 * Adds a label that follows the annotation's subject through a finished footage clip. Returns
 * false (leaving the clip as it was) when the subject can't be found or followed long enough.
 */
export async function labelMovingSubject(options: {
  clipPath: string;
  annotation: Annotation;
  theme: MotionTheme;
  llm: LLMProvider;
  llmCtx: ProviderCallContext;
  title?: string;
  browser?: Browser;
}): Promise<boolean> {
  const { clipPath, annotation, theme } = options;
  const work = `${clipPath}.track`;
  await fs.mkdir(work, { recursive: true });
  try {
    const firstFrame = path.join(work, 'first.jpg');
    await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-i', clipPath, '-frames:v', '1', '-q:v', '3', firstFrame]);
    const box: TargetBox | null = await locateTarget(firstFrame, annotation, options.llm, options.llmCtx, options.title);
    if (!box) return false;
    const [ymin, xmin, ymax, xmax] = box;
    const frames = await greyFrames(clipPath);
    if (frames.length < FPS) return false;
    const toTrack = { x: (xmin / 1000) * TRACK_W, y: (ymin / 1000) * TRACK_H, w: ((xmax - xmin) / 1000) * TRACK_W, h: ((ymax - ymin) / 1000) * TRACK_H };
    const track = smoothTrack(trackTarget(frames, toTrack));
    const followed = track.filter(Boolean).length;
    // A label that would flash for under a second isn't worth showing
    if (followed < FPS) return false;

    const sx = FRAME_WIDTH / TRACK_W;
    const sy = FRAME_HEIGHT / TRACK_H;
    const ringPx = Math.max(90, Math.min(420, Math.max(((xmax - xmin) / 1000) * FRAME_WIDTH, ((ymax - ymin) / 1000) * FRAME_HEIGHT) * 1.15));
    const labelRight = (xmin + xmax) / 2 < 600;
    const art = trackedLabelDocument(theme, annotation, ringPx, labelRight);
    const png = path.join(work, 'label.png');
    const own = options.browser ? null : await chromium.launch({ headless: true });
    const page = await (options.browser ?? own!).newPage({ viewport: { width: art.width, height: art.height } });
    try {
      await page.setContent(art.html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts?.ready);
      await page.screenshot({ path: png, omitBackground: true });
    } finally {
      await page.close().catch(() => {});
      await own?.close().catch(() => {});
    }

    // The label's position frame by frame; it fades in, and out where the subject is lost
    const lines: string[] = [];
    track.forEach((p, i) => {
      if (!p) return;
      const x = Math.round(p.x * sx - art.anchor.x);
      const y = Math.round(p.y * sy - art.anchor.y);
      lines.push(`${(i / FPS).toFixed(3)} overlay@trk x ${x}, overlay@trk y ${y};`);
    });
    const commands = path.join(work, 'track.txt');
    await fs.writeFile(commands, lines.join('\n') + '\n', 'utf-8');
    const lostAt = followed / FPS;
    const fadeOut = Math.max(0.3, lostAt - 0.35);
    const first = track[0]!;
    const out = path.join(work, 'labelled.mp4');
    await execFileAsync(
      getFfmpegPath(),
      [
        '-y', '-v', 'error', '-i', clipPath, '-loop', '1', '-i', png,
        '-filter_complex',
        `[1:v]format=rgba,fade=t=in:st=0.3:d=0.4:alpha=1,fade=t=out:st=${fadeOut.toFixed(3)}:d=0.3:alpha=1[lab];` +
          `[0:v]sendcmd=f=track.txt[base];[base][lab]overlay@trk=x=${Math.round(first.x * sx - art.anchor.x)}:y=${Math.round(first.y * sy - art.anchor.y)}:shortest=1:eval=frame,scale=out_range=tv,format=yuv420p[v]`,
        '-map', '[v]', '-frames:v', String(frames.length), ...ENCODE, out,
      ],
      { cwd: work },
    );
    await fs.rename(out, clipPath);
    return true;
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
