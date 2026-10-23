import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath, getFfprobePath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);

/**
 * The final mastering pass: the whole programme's loudness is measured, then set to YouTube's
 * reference in a second, linear pass (no pumping), the sound fades out at the very end, and,
 * when captions are wanted, they're burned in during the one final picture encode.
 */

/** YouTube normalises playback to about -14 LUFS; mastering to it keeps full dynamic range. */
export const TARGET_LUFS = -14;
export const TARGET_TRUE_PEAK = -1;
const TARGET_LRA = 11;
const END_FADE_SEC = 0.8;

/** Delivery picture: high quality for YouTube's re-encode, at a speed this machine can manage. */
export const MASTER_VIDEO_ENCODE = ['-c:v', 'libx264', '-preset', 'faster', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart'];
const MASTER_AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2'];

export interface LoudnessMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** Integrated loudness, true peak and range of a file's audio (loudnorm's first pass). */
export async function measureLoudness(filePath: string): Promise<LoudnessMeasurement> {
  const { stderr } = await execFileAsync(
    getFfmpegPath(),
    [
      '-hide_banner', '-nostats', '-i', filePath, '-vn',
      '-af', `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK}:LRA=${TARGET_LRA}:print_format=json`,
      '-f', 'null', '-',
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1);
  const m = JSON.parse(json) as LoudnessMeasurement;
  if (!Number.isFinite(Number.parseFloat(m.input_i))) throw new Error(`Could not measure loudness of ${filePath}`);
  return m;
}

/** The second loudnorm pass: a single gain change computed from the measurement. */
export function loudnessCorrectionFilter(m: LoudnessMeasurement): string {
  return (
    `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK}:LRA=${TARGET_LRA}` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
  );
}

/** The video stream's colour range tag ('tv', 'pc', or 'unknown'). */
export async function videoColorRange(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(getFfprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_range,pix_fmt', '-of', 'csv=p=0', filePath]);
    const [pixFmt, range] = stdout.trim().split(',');
    return pixFmt?.startsWith('yuvj') ? 'pc' : range || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function durationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(getFfprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
  ]);
  return Number.parseFloat(stdout.trim()) || 0;
}

export interface MasterOptions {
  inputPath: string;
  outputPath: string;
  /** Captions to burn in (ASS file). */
  assPath?: string | null;
  /** The style's grade (see look.ts), applied before captions. Without grade or captions the picture is copied. */
  lookFilter?: string | null;
  /**
   * Emphasis effects (see emphasis.ts): a graph from [vin] to [vfx] with its extra inputs, and
   * letterbox bars drawn after the grade.
   */
  emphasis?: { graph: string; inputs: string[]; letterbox?: string | null } | null;
  /** A quick preview: half size and the fastest encode. */
  draft?: boolean;
}

/**
 * Produces the delivery file. Audio is always mastered; the picture is re-encoded only when
 * captions need burning in, so a video without captions loses no picture quality here.
 */
export async function masterFinalVideo(options: MasterOptions): Promise<{ outputPath: string; measured: LoudnessMeasurement }> {
  const { inputPath, outputPath, assPath, lookFilter, emphasis, draft } = options;
  const videoEncode = draft ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart'] : MASTER_VIDEO_ENCODE;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const measured = await measureLoudness(inputPath);
  const total = await durationSec(inputPath);
  const fade = Math.min(END_FADE_SEC, total / 4);
  const af = `${loudnessCorrectionFilter(measured)},aresample=48000,afade=t=out:st=${Math.max(0, total - fade).toFixed(3)}:d=${fade.toFixed(3)}`;

  const args = ['-y', '-i', path.resolve(inputPath), '-map', '0:v:0', '-map', '0:a:0'];
  // The grade comes first so captions keep their exact colours; the ASS file is referenced by
  // bare name from its own folder (no escaping of Windows drive letters)
  const effects = [lookFilter, emphasis?.letterbox, assPath ? `ass=${path.basename(assPath)}` : null, draft ? 'scale=960:540' : null].filter(Boolean);
  // A full-range source (e.g. from an older render) must be converted, not just copied
  const needsRange = (await videoColorRange(inputPath)) === 'pc';
  if (emphasis && emphasis.graph !== '[vin]null[vfx]') {
    // Emphasis first (captions must not shake or freeze), then the grade, bars and captions
    args.splice(args.indexOf('-map'), 4);
    args.push(
      ...emphasis.inputs,
      '-filter_complex',
      `[0:v]scale=out_range=tv[vin];${emphasis.graph};[vfx]${[...effects, 'format=yuv420p'].join(',')}[vout]`,
      '-map', '[vout]', '-map', '0:a:0',
      ...videoEncode,
    );
  } else if (effects.length || needsRange) {
    args.push('-vf', ['scale=out_range=tv', ...effects, 'format=yuv420p'].join(','), ...videoEncode);
  } else {
    args.push('-c:v', 'copy', '-movflags', '+faststart');
  }
  args.push('-af', af, ...MASTER_AUDIO_ENCODE, path.resolve(outputPath));

  await execFileAsync(getFfmpegPath(), args, {
    cwd: assPath ? path.dirname(path.resolve(assPath)) : undefined,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { outputPath, measured };
}
