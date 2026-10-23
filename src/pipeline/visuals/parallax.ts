import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import { probeMediaFile } from '../utils/media-upload';

const execFileAsync = promisify(execFile);

/**
 * 2.5D parallax for still photos: a depth model (Depth Anything V2, small, run locally) works out
 * how near each part of the photo is, then ffmpeg moves near things more than far ones as the
 * camera glides and pushes in, so a flat photo feels like a scene. The model is downloaded once
 * (about 30 MB) into storage/models.
 */

const MODEL = 'onnx-community/depth-anything-v2-small';
const FPS = 30;
/** The picture is rendered this much larger than the frame, so displaced edges never show. */
const OVERSCAN = 1.1;
const OUT_W = 1920;
const OUT_H = 1080;
const SRC_W = Math.round((OUT_W * OVERSCAN) / 2) * 2;
const SRC_H = Math.round((OUT_H * OVERSCAN) / 2) * 2;
/** Depth maps are smooth: the displacement is worked out at a quarter of the size, then scaled up. */
const MAP_W = Math.round(SRC_W / 4);
const MAP_H = Math.round(SRC_H / 4);
/** Sideways travel of the nearest things across the shot, in pixels. */
const GLIDE_PX = 36;
/** How much more the nearest things grow than the background as the camera pushes in. */
const PUSH = 0.07;
/** Photos much taller or wider than the frame would lose too much to the crop. */
const MIN_ASPECT = 1.3;
const MAX_ASPECT = 2.4;

export const modelsDir = () => path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'models');

type DepthEstimator = (image: string) => Promise<unknown>;
let estimator: Promise<DepthEstimator> | null = null;

async function loadEstimator(): Promise<DepthEstimator> {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = modelsDir();
  return (await pipeline('depth-estimation', MODEL, { dtype: 'q8' })) as unknown as DepthEstimator;
}

/** A greyscale depth map beside the photo (near = bright), reused if already made. */
export async function depthMap(imagePath: string): Promise<string> {
  const out = `${imagePath}.depth.png`;
  if (await fs.stat(out).then((s) => s.size > 0).catch(() => false)) return out;
  estimator ??= loadEstimator().catch((err) => {
    estimator = null;
    throw err;
  });
  const result = (await (await estimator)(imagePath)) as { depth: { save: (p: string) => Promise<void> } };
  await result.depth.save(out);
  return out;
}

/**
 * Whether a photo suits parallax: a landscape picture that fills the frame without losing much.
 * Callers pass stills only (the probe reports a JPEG as a one-frame video).
 */
export async function suitsParallax(imagePath: string): Promise<boolean> {
  const info = await probeMediaFile(imagePath).catch(() => null);
  if (!info || !info.width || !info.height) return false;
  const aspect = info.width / info.height;
  return aspect >= MIN_ASPECT && aspect <= MAX_ASPECT && info.width >= 800;
}

/**
 * The ffmpeg graph: [0] the photo and [1] its depth map, each already scaled (see parallaxClip)
 * and decoded once, then held for every frame. The depth map becomes two displacement maps
 * (128 = no move): a sideways glide where near things move more, and a push-in where near
 * things grow more than the background. Everything is displaced in RGB, so colour moves with
 * brightness and never fringes.
 */
export function parallaxFilter(frames: number, direction: 1 | -1): string {
  const d = Math.max(0.5, frames / FPS).toFixed(3);
  // Eased progress from -1 to 1 across the shot, and 0 to 1 for the push
  const glide = `(${direction}*(2*(0.5-0.5*cos(PI*T/${d}))-1))`;
  const push = `(0.5-0.5*cos(PI*T/${d}))`;
  const depth = '(lum(X,Y)/255)';
  const weight = `(0.25+0.75*${depth})`;
  const dx = `${GLIDE_PX}*${glide}*(${depth}-0.45)-${(PUSH * SRC_W).toFixed(1)}*${push}*(X/W-0.5)*${weight}`;
  const dy = `-${(PUSH * SRC_H).toFixed(1)}*${push}*(Y/H-0.5)*${weight}`;
  const hold = `loop=loop=${Math.max(0, frames - 1)}:size=1:start=0,setpts=N/${FPS}/TB`;
  return [
    `[0:v]format=gbrp,${hold}[src]`,
    `[1:v]format=gray,${hold},split=2[d1][d2]`,
    `[d1]geq=lum='clip(128+${dx},0,255)',scale=${SRC_W}:${SRC_H}:flags=bilinear,format=gbrp[xm]`,
    `[d2]geq=lum='clip(128+${dy},0,255)',scale=${SRC_W}:${SRC_H}:flags=bilinear,format=gbrp[ym]`,
    `[src][xm][ym]displace=edge=smear,crop=${OUT_W}:${OUT_H},scale=out_range=tv,format=yuv420p[v]`,
  ].join(';');
}

/**
 * Renders a parallax clip of exactly `frames` frames. `n` alternates the glide direction between
 * shots. The photo and depth map are scaled once first (scaling a still on every frame doubled
 * the time).
 */
export async function parallaxClip(options: { imagePath: string; depthPath: string; frames: number; outputPath: string; n: number }): Promise<string> {
  const { imagePath, depthPath, frames, outputPath, n } = options;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const photo = `${outputPath}.photo.png`;
  const map = `${outputPath}.depth.png`;
  try {
    await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-i', imagePath, '-vf', `scale=${SRC_W}:${SRC_H}:force_original_aspect_ratio=increase,crop=${SRC_W}:${SRC_H},setsar=1`, '-frames:v', '1', photo]);
    await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-i', depthPath, '-vf', `scale=${MAP_W}:${MAP_H}:force_original_aspect_ratio=increase,crop=${MAP_W}:${MAP_H},format=gray`, '-frames:v', '1', map]);
    await execFileAsync(
      getFfmpegPath(),
      [
        '-y', '-v', 'error', '-i', photo, '-i', map,
        '-filter_complex', parallaxFilter(frames, n % 2 === 0 ? 1 : -1),
        '-map', '[v]', '-frames:v', String(frames),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', String(FPS), '-an',
        outputPath,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return outputPath;
  } finally {
    await Promise.all([photo, map].map((p) => fs.unlink(p).catch(() => {})));
  }
}
