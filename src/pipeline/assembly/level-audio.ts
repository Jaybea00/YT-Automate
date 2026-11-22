import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import { loudnessCorrectionFilter, measureLoudness, TARGET_LUFS, TARGET_TRUE_PEAK, type LoudnessMeasurement } from './master';

const execFileAsync = promisify(execFile);

/**
 * Shorts (clips, compilations, vertical cuts) come out as loud as their source: a quietly recorded
 * clip made a Short that played far softer than everything around it in the feed. This sets a
 * finished file's sound to YouTube's reference (-14 LUFS, true peak -1 dB) with the same two-pass,
 * linear correction as the long-video master, and leaves the picture untouched (stream copy).
 */

/** Within this many LU of the target, a file is left as it is. */
const TOLERANCE_LU = 1;
/** Quieter than this is silence (or no sound worth levelling): left alone. */
const SILENCE_LUFS = -60;

export interface LevelResult {
  /** Integrated loudness before, in LUFS (null when it couldn't be measured). */
  beforeLufs: number | null;
  /** Whether the file was rewritten. */
  changed: boolean;
}

/** Whether a measured file is far enough from the target, or peaks too hot, to need levelling. */
export function needsLevelling(m: Pick<LoudnessMeasurement, 'input_i' | 'input_tp'>): boolean {
  const loudness = Number.parseFloat(m.input_i);
  const peak = Number.parseFloat(m.input_tp);
  if (!Number.isFinite(loudness) || loudness <= SILENCE_LUFS) return false;
  return Math.abs(loudness - TARGET_LUFS) > TOLERANCE_LU || (Number.isFinite(peak) && peak > TARGET_TRUE_PEAK + 0.5);
}

/**
 * Levels a finished video's sound in place. Never throws: if measuring or levelling fails, the
 * file is kept as it was (a quiet Short beats a missing one).
 */
export async function levelAudioInPlace(file: string): Promise<LevelResult> {
  let m: LoudnessMeasurement;
  try {
    m = await measureLoudness(file);
  } catch (err) {
    console.warn(`[Loudness] Could not measure ${file}; left as it is: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return { beforeLufs: null, changed: false };
  }
  const beforeLufs = Number.parseFloat(m.input_i);
  if (!needsLevelling(m)) return { beforeLufs, changed: false };

  const tmp = file.replace(/(\.[^.]+)$/, '.levelled$1');
  try {
    await execFileAsync(
      getFfmpegPath(),
      [
        '-y', '-v', 'error', '-i', file,
        '-map', '0:v?', '-map', '0:a:0',
        '-c:v', 'copy',
        '-af', loudnessCorrectionFilter(m),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart', tmp,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    await fs.rename(tmp, file);
    console.log(`[Loudness] ${file}: ${beforeLufs.toFixed(1)} LUFS -> ${TARGET_LUFS} LUFS`);
    return { beforeLufs, changed: true };
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    console.warn(`[Loudness] Levelling ${file} failed; left as it is: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return { beforeLufs, changed: false };
  }
}
