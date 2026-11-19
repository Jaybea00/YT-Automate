import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { findPeaks, measureLoudness, probeClip, transcribe } from '../clipping/analyze';
import { LOUDNESS_STEP } from '../clipping/types';
import { getFfmpegPath } from '../utils/ffmpeg';
import type { ItemAnalysis } from './types';

const execFileAsync = promisify(execFile);

/**
 * What a compilation needs to know about one item: its size, whether it has sound, its loudest
 * moment and its dialogue (Whisper, only on the part used). Times are seconds into the file.
 */
export async function analyzeItem(file: string, range: { start: number; end: number }, workDir: string): Promise<{ analysis: ItemAnalysis; warning?: string }> {
  const info = await probeClip(file);
  if (!info.hasAudio) return { analysis: { ...info, peakSec: null, words: [] } };

  const wav = path.join(workDir, `item_${randomBytes(3).toString('hex')}.wav`);
  try {
    await fs.mkdir(workDir, { recursive: true });
    const len = Math.max(0.5, Math.min(range.end, info.durationSec) - range.start);
    await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', range.start.toFixed(2), '-t', len.toFixed(2), '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav]);
    const loudness = await measureLoudness(wav).catch(() => []);
    const peak = findPeaks(loudness, LOUDNESS_STEP, { max: 1 })[0];
    let words: ItemAnalysis['words'] = [];
    let warning: string | undefined;
    try {
      words = (await transcribe(wav, len)).words.map((w) => ({ ...w, start: w.start + range.start, end: w.end + range.start }));
    } catch (err) {
      warning = `Dialogue could not be transcribed, so captions are missing: ${err instanceof Error ? err.message.slice(0, 120) : err}`;
    }
    return { analysis: { ...info, peakSec: peak ? Math.round((peak.at + range.start) * 10) / 10 : null, words }, warning };
  } finally {
    await fs.unlink(wav).catch(() => {});
  }
}
