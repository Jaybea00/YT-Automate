import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { getFfmpegPath } from '../utils/ffmpeg';
import { motionDocument, FRAME_HEIGHT, FRAME_WIDTH } from '../visuals/motion/frame-renderer';
import { escapeHtml } from '../visuals/motion/templates';
import type { MotionTheme } from '../visuals/motion/theme';
import { SCENE_AUDIO_ENCODE, SCENE_VIDEO_ENCODE } from './assemble-beat';

const execFileAsync = promisify(execFile);

/**
 * The end screen: a calm closing stretch after the last line, so the video doesn't just stop and
 * YouTube's end-screen boxes (the next video, subscribe) have somewhere to sit. The last shot,
 * blurred and dimmed and drifting slowly, under a short heading at the top; the middle and lower
 * part of the frame are left clear for the boxes. The music carries on under it (it is joined
 * like any other scene, before the music is laid) and rises a little now that no one is speaking.
 *
 * YouTube allows end-screen elements in the last 5-20 seconds.
 */

export const END_SCREEN_MIN_SEC = 5;
export const END_SCREEN_MAX_SEC = 20;
export const END_SCREEN_DEFAULT_SEC = 12;
export const END_SCREEN_DEFAULT_TEXT = 'Watch next';

export interface EndScreenSettings {
  enabled: boolean;
  seconds: number;
  text: string;
}

/** The video's end-screen settings (script_json.end_screen), with defaults: on, 12 s, "Watch next". */
export function endScreenSettings(raw: unknown): EndScreenSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const sec = typeof r.seconds === 'number' && Number.isFinite(r.seconds) ? r.seconds : END_SCREEN_DEFAULT_SEC;
  return {
    enabled: r.enabled !== false,
    seconds: Math.round(Math.max(END_SCREEN_MIN_SEC, Math.min(END_SCREEN_MAX_SEC, sec))),
    text: typeof r.text === 'string' ? r.text.trim().slice(0, 60) : END_SCREEN_DEFAULT_TEXT,
  };
}

/**
 * The music's lift under the end screen, as a volume expression (multiplies the music's level):
 * 1 before it, rising to 1.8x over a second and a half once the voice has stopped.
 */
export function endScreenMusicLift(startSec: number): string {
  return `if(lt(t,${startSec.toFixed(3)}),1,1+0.8*min(1,(t-${startSec.toFixed(3)})/1.5))`;
}

/** The heading at the top of the end screen, as a page for the frame renderer. */
export function endScreenHeadingDocument(theme: MotionTheme, text: string): string {
  return motionDocument({
    css:
      `html,body{background:transparent}` +
      `.h{position:absolute;left:50%;top:150px;transform:translateX(-50%);font-family:${theme.headingFont};font-weight:800;font-size:76px;` +
      `color:#fbf8f1;letter-spacing:.02em;white-space:nowrap;text-shadow:0 8px 30px rgba(0,0,0,.6)}` +
      `.h:after{content:"";display:block;margin:18px auto 0;width:140px;height:8px;border-radius:4px;background:${theme.accent}}`,
    body: `<div class="h">${escapeHtml(text)}</div>`,
    script: '',
  });
}

async function renderHeading(theme: MotionTheme, text: string, file: string): Promise<string | null> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: FRAME_WIDTH, height: FRAME_HEIGHT } });
    await page.setContent(endScreenHeadingDocument(theme, text), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    await page.screenshot({ path: file, omitBackground: true });
    return file;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** The ffmpeg graph: the held last frame blurred, dimmed and slowly pushing in, with the heading fading in over it. */
export function endScreenGraph(seconds: number, withHeading: boolean): string {
  const S = seconds.toFixed(3);
  const bg =
    `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=24:2,eq=brightness=-0.22:saturation=0.7,` +
    `scale=w='trunc(1920*(1+0.06*t/${S})/2)*2':h=-2:eval=frame,crop=1920:1080,fps=30,format=yuv420p`;
  if (!withHeading) return `${bg}[vout]`;
  return `${bg}[bg];[1:v]format=rgba,fade=t=in:st=0.5:d=0.8:alpha=1[hd];[bg][hd]overlay=0:0:format=auto,format=yuv420p[vout]`;
}

/**
 * Renders the end-screen clip from the last scene, in the same format as the scene clips so it
 * joins like one. The heading is skipped (not the end screen) if the frame renderer fails.
 */
export async function renderEndScreen(options: {
  lastScenePath: string;
  outputPath: string;
  settings: EndScreenSettings;
  theme: MotionTheme;
}): Promise<string> {
  const { lastScenePath, outputPath, settings, theme } = options;
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });
  const still = path.join(dir, 'end_screen_frame.png');
  await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-sseof', '-0.2', '-i', lastScenePath, '-frames:v', '1', '-update', '1', still]);
  const heading = settings.text
    ? await renderHeading(theme, settings.text, path.join(dir, 'end_screen_heading.png')).catch((err) => {
        console.warn('[Assembly] End screen heading skipped:', err instanceof Error ? err.message.slice(0, 200) : err);
        return null;
      })
    : null;
  const S = String(settings.seconds);
  const args = ['-y', '-v', 'error', '-loop', '1', '-framerate', '30', '-t', S, '-i', still];
  if (heading) args.push('-loop', '1', '-framerate', '30', '-t', S, '-i', heading);
  args.push(
    '-f', 'lavfi', '-t', S, '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex', endScreenGraph(settings.seconds, Boolean(heading)),
    '-map', '[vout]', '-map', `${heading ? 2 : 1}:a:0`,
    ...SCENE_VIDEO_ENCODE, '-r', '30', ...SCENE_AUDIO_ENCODE, '-t', S, outputPath,
  );
  await execFileAsync(getFfmpegPath(), args, { maxBuffer: 16 * 1024 * 1024 });
  await fs.rm(still, { force: true }).catch(() => {});
  return outputPath;
}
