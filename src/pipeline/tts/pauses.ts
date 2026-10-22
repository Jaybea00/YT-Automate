import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAudioDurationMs, getFfmpegPath } from '../utils/ffmpeg';
import { alignWordTimings, type WordTiming } from './word-timings';

const execFileAsync = promisify(execFile);

/**
 * Documentary pacing: a breath between sentences. Voices run sentences together at a news-reader
 * pace; documentary narration lets each one land. The voice's own word timings show where every
 * sentence ends, so silence is inserted exactly there and the timings are shifted to match (so
 * captions and shot cuts stay on the words).
 */

/** A word ending a sentence: ".", "!" or "?", possibly followed by a closing quote or bracket. */
const SENTENCE_END = /[.!?]["'”’)\]]*$/;

/**
 * Where to add a pause, in seconds into the audio: midway through the natural gap after each
 * sentence-ending word (never after the last word). `aligned` is the narration's word timings.
 */
export function sentencePausePoints(narration: string, aligned: WordTiming[]): number[] {
  const words = narration.trim().split(/\s+/).filter(Boolean);
  const points: number[] = [];
  for (let i = 0; i < Math.min(words.length, aligned.length) - 1; i++) {
    if (!SENTENCE_END.test(words[i])) continue;
    const gapStart = aligned[i].end;
    const gapEnd = aligned[i + 1].start;
    points.push(Math.round(((gapStart + Math.max(gapStart, gapEnd)) / 2) * 1000) / 1000);
  }
  return points;
}

/** Word timings after inserting `pauseSec` of silence at each point. */
export function shiftWordsForPauses(words: WordTiming[], points: number[], pauseSec: number): WordTiming[] {
  return words.map((w) => {
    const before = points.filter((p) => p <= w.start + 1e-6).length;
    return { ...w, start: w.start + before * pauseSec, end: w.end + before * pauseSec };
  });
}

/** ffmpeg filter graph that splits the audio at `points` and pads each piece but the last. */
export function pauseFilter(points: number[], pauseSec: number): string {
  const n = points.length + 1;
  const labels = Array.from({ length: n }, (_, i) => `a${i}`);
  const parts = [`[0:a]asplit=${n}${labels.map((l) => `[${l}]`).join('')}`];
  const bounds = [0, ...points];
  bounds.forEach((start, i) => {
    const end = points[i];
    const trim = end === undefined ? `atrim=start=${start}` : `atrim=start=${start}:end=${end}`;
    const pad = end === undefined ? '' : `,apad=pad_dur=${pauseSec}`;
    parts.push(`[a${i}]${trim},asetpts=PTS-STARTPTS${pad}[s${i}]`);
  });
  parts.push(`${labels.map((_, i) => `[s${i}]`).join('')}concat=n=${n}:v=0:a=1[out]`);
  return parts.join(';');
}

/**
 * Adds a pause after every sentence of a voiced beat. Needs the voice's word timings (Kokoro
 * provides them); without them the audio is returned unchanged. Returns the new audio and the
 * provider's word timings shifted to match.
 */
export async function addSentencePauses(args: {
  bytes: Uint8Array;
  narration: string;
  providerWords?: WordTiming[];
  pauseSec: number;
}): Promise<{ bytes: Uint8Array; providerWords?: WordTiming[]; pauses: number }> {
  const { bytes, narration, providerWords, pauseSec } = args;
  if (!providerWords?.length || pauseSec <= 0) return { bytes, providerWords, pauses: 0 };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pauses-'));
  try {
    const input = path.join(dir, 'in.mp3');
    const output = path.join(dir, 'out.mp3');
    await fs.writeFile(input, bytes);
    const durationSec = (await getAudioDurationMs(input)) / 1000;
    const points = sentencePausePoints(narration, alignWordTimings(narration, providerWords, durationSec)).filter(
      (p) => p > 0.05 && p < durationSec - 0.05,
    );
    if (points.length === 0) return { bytes, providerWords, pauses: 0 };

    await execFileAsync(getFfmpegPath(), [
      '-y', '-v', 'error', '-i', input,
      '-filter_complex', pauseFilter(points, pauseSec),
      '-map', '[out]', '-c:a', 'libmp3lame', '-q:a', '2', output,
    ]);
    return {
      bytes: new Uint8Array(await fs.readFile(output)),
      providerWords: shiftWordsForPauses(providerWords, points, pauseSec),
      pauses: points.length,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
