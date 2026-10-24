import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfprobePath } from '../utils/ffmpeg';
import { modelsDir } from './parallax';

const execFileAsync = promisify(execFile);

/**
 * Sharpening small photos: old or low-resolution pictures shown full screen look soft, so those
 * under MIN_WIDTH are upscaled 2x by a small super-resolution model (Swin2SR) running on this
 * computer. Slow on a small laptop (minutes per photo), so it's switched on per video.
 */

export const MIN_WIDTH = 960;
const MODEL = 'Xenova/swin2SR-classical-sr-x2-64';

type Upscaler = (image: string) => Promise<unknown>;
let upscaler: Promise<Upscaler> | null = null;

async function loadUpscaler(): Promise<Upscaler> {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = modelsDir();
  return (await pipeline('image-to-image', MODEL, { dtype: 'q8' } as never)) as unknown as Upscaler;
}

async function imageWidth(file: string): Promise<number> {
  const { stdout } = await execFileAsync(getFfprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', file]);
  return Number.parseInt(stdout.trim(), 10) || 0;
}

/**
 * The photo to use: an upscaled copy when the original is small (made once, kept beside it),
 * otherwise the original. Any failure falls back to the original.
 */
export async function sharpenSmallPhoto(photoPath: string, upscale: Upscaler | null = null): Promise<string> {
  const out = `${photoPath}.x2.png`;
  if (await fs.stat(out).then((s) => s.size > 0).catch(() => false)) return out;
  try {
    const width = await imageWidth(photoPath);
    if (!width || width >= MIN_WIDTH) return photoPath;
    let run = upscale;
    if (!run) {
      upscaler ??= loadUpscaler().catch((err) => {
        upscaler = null;
        throw err;
      });
      run = await upscaler;
    }
    const result = await run(photoPath);
    const image = (Array.isArray(result) ? result[0] : result) as { save: (p: string) => Promise<void> };
    await image.save(out);
    return out;
  } catch (err) {
    console.warn(`[Upscale] Kept the original photo (${err instanceof Error ? err.message.slice(0, 120) : err})`);
    return photoPath;
  }
}
