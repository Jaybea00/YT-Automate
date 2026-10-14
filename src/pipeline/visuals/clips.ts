import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import { BLUR_PAD_VIDEO_HOLD_FC } from '../assembly/assemble-beat';
import { FPS } from './motion/frame-renderer';

const execFileAsync = promisify(execFile);

export type StillMotion = 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right';
export const STILL_MOTIONS: StillMotion[] = ['zoom_in', 'pan_right', 'zoom_out', 'pan_left'];

const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an'];

/**
 * Camera move for a still, as zoompan expressions over `frames` output frames. Stills are
 * upscaled to 4K first so sub-pixel movement doesn't jitter at 1080p.
 */
export function kenBurnsFilter(motion: StillMotion, frames: number): string {
  const n = Math.max(1, frames - 1);
  const progress = `(on/${n})`;
  const centerX = "iw/2-(iw/zoom/2)";
  const centerY = "ih/2-(ih/zoom/2)";
  const moves: Record<StillMotion, { z: string; x: string; y: string }> = {
    zoom_in: { z: `1+0.14*${progress}`, x: centerX, y: centerY },
    zoom_out: { z: `1.14-0.14*${progress}`, x: centerX, y: centerY },
    pan_right: { z: '1.12', x: `(iw-iw/zoom)*${progress}`, y: centerY },
    pan_left: { z: '1.12', x: `(iw-iw/zoom)*(1-${progress})`, y: centerY },
  };
  const { z, x, y } = moves[motion];
  return `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=1920x1080:fps=${FPS}`;
}

/** Still image (any aspect) -> blurred-fill 16:9 frame -> camera move, exact frame count. */
async function stillClip(inputPath: string, frames: number, outputPath: string, motion: StillMotion): Promise<void> {
  const filter =
    '[0:v]split=2[bg][fg];' +
    '[bg]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,gblur=sigma=40,eq=brightness=-0.1[bgb];' +
    '[fg]scale=3840:2160:force_original_aspect_ratio=decrease[fgs];' +
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,${kenBurnsFilter(motion, frames)},setsar=1,format=yuv420p[v]`;
  await execFileAsync(getFfmpegPath(), ['-y', '-i', inputPath, '-filter_complex', filter, '-map', '[v]', '-frames:v', String(frames), ...ENCODE, outputPath]);
}

/** Video -> blurred-fill 16:9, starting at `startSec`, holding the last frame if it runs short. */
async function videoClip(inputPath: string, frames: number, outputPath: string, startSec: number): Promise<void> {
  const seconds = frames / FPS;
  const filter = BLUR_PAD_VIDEO_HOLD_FC.replace('[vout]', `,fps=${FPS}[vout]`);
  await execFileAsync(getFfmpegPath(), [
    '-y',
    ...(startSec > 0 ? ['-ss', startSec.toFixed(3)] : []),
    '-t', (seconds + 1).toFixed(3),
    '-i', inputPath,
    '-filter_complex', filter,
    '-map', '[vout]',
    '-frames:v', String(frames),
    ...ENCODE,
    outputPath,
  ]);
}

export interface FootageClipOptions {
  inputPath: string;
  isVideo: boolean;
  frames: number;
  outputPath: string;
  /** Video only: where in the source to start. */
  startSec?: number;
  /** Still only: which camera move. */
  motion?: StillMotion;
}

/** Renders a silent 1920x1080 clip of exactly `frames` frames from a photo or video. */
export async function makeFootageClip(options: FootageClipOptions): Promise<string> {
  const { inputPath, isVideo, frames, outputPath, startSec = 0, motion = 'zoom_in' } = options;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    if (isVideo) await videoClip(inputPath, frames, outputPath, startSec);
    else await stillClip(inputPath, frames, outputPath, motion);
    return outputPath;
  } catch (err) {
    throw new Error(`Failed to make footage clip from ${path.basename(inputPath)}: ${err instanceof Error ? err.message.slice(-400) : err}`);
  }
}

/**
 * Lays a transparent 1920x1080 PNG (a lower-third caption) over a clip: it slides in and fades
 * up shortly after the cut, and fades out before the end when the shot is long enough.
 */
export async function overlayCaption(clipPath: string, overlayPng: string, frames: number, outputPath: string): Promise<string> {
  const seconds = frames / FPS;
  const inAt = 0.35;
  const inLen = 0.45;
  const fadeOut = seconds > 3 ? `,fade=t=out:st=${(seconds - 0.55).toFixed(3)}:d=0.4:alpha=1` : '';
  const slide = `-70*(1-min(1,max(0,(t-${inAt})/${inLen})))`;
  const filter =
    `[1:v]format=rgba,fade=t=in:st=${inAt}:d=${inLen}:alpha=1${fadeOut}[cap];` +
    `[0:v][cap]overlay=x='${slide}':y=0:eval=frame:shortest=1,format=yuv420p[v]`;
  await execFileAsync(getFfmpegPath(), [
    '-y', '-i', clipPath, '-loop', '1', '-framerate', String(FPS), '-i', overlayPng,
    '-filter_complex', filter, '-map', '[v]', '-frames:v', String(frames), ...ENCODE, outputPath,
  ]);
  return outputPath;
}

/** A plain color clip, used when a shot can't be sourced so the beat still has exact timing. */
export async function makeColorClip(color: string, frames: number, outputPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(getFfmpegPath(), [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1920x1080:r=${FPS}`, '-frames:v', String(frames), ...ENCODE, outputPath,
  ]);
  return outputPath;
}

/**
 * Joins shot clips (all 1920x1080, 30 fps, H.264) into one beat track. Clips share encoding
 * settings, so stream copy is lossless and fast.
 */
export async function concatClips(clipPaths: string[], outputPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (clipPaths.length === 1) {
    await fs.copyFile(clipPaths[0], outputPath);
    return outputPath;
  }
  const listPath = `${outputPath}.concat.txt`;
  await fs.writeFile(listPath, clipPaths.map((p) => `file '${path.resolve(p).replace(/\\/g, '/')}'`).join('\n'), 'utf-8');
  try {
    await execFileAsync(getFfmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
  } finally {
    await fs.unlink(listPath).catch(() => {});
  }
  return outputPath;
}
