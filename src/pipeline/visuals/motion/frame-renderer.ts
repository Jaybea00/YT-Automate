import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import { getFfmpegPath } from '../../utils/ffmpeg';

export const FRAME_WIDTH = 1920;
export const FRAME_HEIGHT = 1080;
export const FPS = 30;

export interface RenderMotionOptions {
  /** A page that defines `window.__frame(t, duration)` to draw its state at time t (seconds). */
  html: string;
  durationSec: number;
  outputPath: string;
  browser?: Browser;
  fps?: number;
}

/**
 * Deterministic frame-by-frame rendering: the page draws each frame on demand and every
 * screenshot is streamed into ffmpeg. Unlike real-time screen recording, motion stays perfectly
 * smooth however slow the machine is, and the same input always renders the same video.
 *
 * Page contract: `window.__frame(t: number, duration: number)` sets the visual state for time t.
 * An optional `window.__ready()` promise (fonts, images) is awaited before the first frame.
 */
export async function renderMotionClip(options: RenderMotionOptions): Promise<string> {
  const { html, durationSec, outputPath, browser: sharedBrowser, fps = FPS } = options;
  const frames = Math.max(1, Math.round(durationSec * fps));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const browser = sharedBrowser ?? (await chromium.launch({ headless: true }));
  const context = await browser.newContext({ viewport: { width: FRAME_WIDTH, height: FRAME_HEIGHT }, deviceScaleFactor: 1 });
  const ffmpeg = spawn(getFfmpegPath(), [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(fps),
    '-c:v', 'mjpeg',
    '-i', '-',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    // Same settings as footage clips (clips.ts) so shots join losslessly with stream copy
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-frames:v', String(frames),
    '-an',
    outputPath,
  ]);
  let stderr = '';
  ffmpeg.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
  const exited = new Promise<number>((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => resolve(code ?? 1));
  });

  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(async () => {
      const w = window as unknown as { __ready?: () => Promise<void> };
      await document.fonts?.ready;
      if (typeof w.__ready === 'function') await w.__ready();
    });

    for (let i = 0; i < frames; i++) {
      const t = i / fps;
      await page.evaluate(
        ([time, duration]) => (window as unknown as { __frame: (t: number, d: number) => void }).__frame(time, duration),
        [t, durationSec] as const,
      );
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 92 });
      if (!ffmpeg.stdin.write(jpeg)) {
        await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
      }
    }
  } catch (err) {
    ffmpeg.kill('SIGKILL');
    throw err;
  } finally {
    ffmpeg.stdin.end();
    await context.close().catch(() => {});
    if (!sharedBrowser) await browser.close().catch(() => {});
  }

  const code = await exited;
  if (code !== 0) {
    throw new Error(`ffmpeg failed encoding motion frames (exit ${code}): ${stderr.slice(-600)}`);
  }
  return outputPath;
}

/** Wraps a page body and script into a full 1920x1080 document that fills the frame. */
export function motionDocument(options: { css: string; body: string; script: string; fontsCss?: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${options.fontsCss ?? ''}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${FRAME_WIDTH}px;height:${FRAME_HEIGHT}px;overflow:hidden}
${options.css}
</style></head><body>${options.body}<script>(()=>{${options.script}})();</script></body></html>`;
}
