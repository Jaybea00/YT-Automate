import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { ShotPlan } from '@/lib/script/generate-script';
import { getFfmpegPath } from '../utils/ffmpeg';
import { generateAiVisualCandidate } from './ai-image-step';
import { ENCODE } from './clips';
import { motionDocument } from './motion/frame-renderer';
import type { MotionTheme } from './motion/theme';
import { renderCandidateShot, type TypedShotRenderer } from './shot-renderers';

const execFileAsync = promisify(execFile);

/**
 * Labelled AI illustrations for what no camera could capture (a black hole, a Roman legion, the
 * inside of a cell). Made with Pollinations, which is free and needs no key, so no credits are
 * spent; every one carries an "Illustration" tag so viewers know it isn't a photograph.
 */

export const ILLUSTRATION_CREDIT = 'AI illustration (Pollinations)';

/** The small corner tag, as a transparent page. */
export function illustrationTagDocument(theme: MotionTheme): string {
  return motionDocument({
    css: `html,body{width:360px;height:90px;background:transparent}
.t{position:absolute;left:12px;top:14px;font:700 26px ${theme.bodyFont};letter-spacing:3px;text-transform:uppercase;color:#fbf8f1;background:rgba(10,10,12,.66);padding:8px 16px;border-radius:4px;border-left:5px solid ${theme.accent}}`,
    body: '<div class="t">Illustration</div>',
    script: '',
  });
}

/** Lays the tag in the top-left corner of a finished clip (same length, joins like any shot). */
export async function tagAsIllustration(clipPath: string, theme: MotionTheme, browser?: Browser): Promise<void> {
  const png = `${clipPath}.tag.png`;
  const out = `${clipPath}.tagged.mp4`;
  const own = browser ? null : await chromium.launch({ headless: true });
  const page = await (browser ?? own!).newPage({ viewport: { width: 360, height: 90 } });
  try {
    await page.setContent(illustrationTagDocument(theme), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    await page.screenshot({ path: png, omitBackground: true });
  } finally {
    await page.close().catch(() => {});
    await own?.close().catch(() => {});
  }
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', clipPath]);
    await execFileAsync(getFfmpegPath(), [
      '-y', '-v', 'error', '-i', clipPath, '-loop', '1', '-i', png,
      '-filter_complex', '[0:v][1:v]overlay=44:36:shortest=1,scale=out_range=tv,format=yuv420p[v]',
      '-map', '[v]', '-frames:v', stdout.trim() || '1', ...ENCODE, out,
    ]);
    await fs.rename(out, clipPath);
  } finally {
    await fs.rm(png, { force: true }).catch(() => {});
    await fs.rm(out, { force: true }).catch(() => {});
  }
}

/** The picture to ask for: the shot's prompt, or its subject and narration. */
export function illustrationPrompt(shot: Pick<ShotPlan, 'illustration' | 'visual_query' | 'covers'>): string {
  return (shot.illustration?.prompt || shot.visual_query || shot.covers).trim().slice(0, 400);
}

export const renderIllustration: TypedShotRenderer = async (shot, slot, clipPath, ctx) => {
  const prompt = illustrationPrompt(shot);
  if (!prompt) throw new Error('illustration has no prompt');
  const candidate = await generateAiVisualCandidate({ prompt, text: shot.covers });
  // Rendered as a still (camera move, parallax when on), then tagged
  const rendered = await renderCandidateShot({ ...shot, caption: undefined, annotation: undefined }, slot, clipPath, ctx, candidate, { note: 'AI illustration' });
  await tagAsIllustration(rendered.clipPath, ctx.theme, ctx.browser);
  return {
    ...rendered,
    renderedType: 'illustration',
    license: 'generated',
    licenseSource: 'pollinations',
    attribution: ILLUSTRATION_CREDIT,
    note: `AI illustration: ${prompt.slice(0, 80)}`,
  };
};


/**
 * Stamps the "Illustration" tag onto a still image itself (for a whole-beat AI picture, which
 * assembly shows as a photo), sized to the image so it reads the same at 1080p.
 */
export async function tagImageAsIllustration(imagePath: string, theme: MotionTheme, browser?: Browser): Promise<void> {
  const png = `${imagePath}.tag.png`;
  const out = `${imagePath}.tagged${path.extname(imagePath) || '.jpg'}`;
  const own = browser ? null : await chromium.launch({ headless: true });
  const page = await (browser ?? own!).newPage({ viewport: { width: 360, height: 90 } });
  try {
    await page.setContent(illustrationTagDocument(theme), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    await page.screenshot({ path: png, omitBackground: true });
  } finally {
    await page.close().catch(() => {});
    await own?.close().catch(() => {});
  }
  try {
    // The tag is sized as it would be on a 1920 px frame, scaled to this picture's width
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', imagePath]);
    const [width, height] = stdout.trim().split(',').map(Number);
    const k = (width || 1920) / 1920;
    await execFileAsync(getFfmpegPath(), [
      '-y', '-v', 'error', '-i', imagePath, '-i', png,
      '-filter_complex', `[1:v]scale=${Math.max(2, Math.round(360 * k))}:-1[tag];[0:v][tag]overlay=${Math.round(44 * k)}:${Math.round(36 * ((height || 1080) / 1080))}`,
      '-frames:v', '1', '-q:v', '2', out,
    ]);
    await fs.rename(out, imagePath);
  } finally {
    await fs.rm(png, { force: true }).catch(() => {});
    await fs.rm(out, { force: true }).catch(() => {});
  }
}
