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
 *
 * Pacing marks: an ellipsis ("He fired twice… Silence.") is the writer's deliberate dramatic
 * pause, and gets a longer one.
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

/** A word ending in an ellipsis ("…" or "..."), possibly followed by a closing quote or bracket. */
const ELLIPSIS_END = /(…|\.\.\.)["'”’)\]]*$/;
/** A token with no letters or digits, e.g. a free-standing "…" or "—". */
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u;

export interface PausePoint {
  /** Seconds into the audio. */
  at: number;
  /** Silence to add there. */
  sec: number;
}

/**
 * Where to pause and for how long: a dramatic pause after each pacing mark (when
 * `dramaticPauseSec` > 0) and a sentence pause after other sentence ends. A free-standing mark
 * ("twice. … Silence") counts with the word before it. Never after the last word.
 */
export function pacingPausePoints(
  narration: string,
  aligned: WordTiming[],
  opts: { sentencePauseSec: number; dramaticPauseSec: number },
): PausePoint[] {
  const words = narration.trim().split(/\s+/).filter(Boolean);
  const n = Math.min(words.length, aligned.length);
  const points: PausePoint[] = [];
  for (let i = 0; i < n - 1; i++) {
    if (PUNCTUATION_ONLY.test(words[i]) && i > 0) continue;
    // Gather free-standing punctuation after the word into its ending
    let j = i;
    let ending = words[i];
    while (j + 1 < n && PUNCTUATION_ONLY.test(words[j + 1])) ending += words[++j];
    if (j >= n - 1) break;
    const dramatic = opts.dramaticPauseSec > 0 && ELLIPSIS_END.test(ending);
    const sentenceEnd = SENTENCE_END.test(words[i]) || SENTENCE_END.test(ending);
    const sec = dramatic ? Math.max(opts.dramaticPauseSec, opts.sentencePauseSec) : sentenceEnd ? opts.sentencePauseSec : 0;
    if (sec <= 0) continue;
    const gapStart = aligned[i].end;
    const gapEnd = aligned[j + 1].start;
    points.push({ at: Math.round(((gapStart + Math.max(gapStart, gapEnd)) / 2) * 1000) / 1000, sec });
  }
  return points;
}

/** Word timings after inserting each point's silence. */
export function shiftWordsForPausePoints(words: WordTiming[], points: PausePoint[]): WordTiming[] {
  return words.map((w) => {
    const shift = points.filter((p) => p.at <= w.start + 1e-6).reduce((sum, p) => sum + p.sec, 0);
    return { ...w, start: w.start + shift, end: w.end + shift };
  });
}

/** Word timings after inserting `pauseSec` of silence at each point. */
export function shiftWordsForPauses(words: WordTiming[], points: number[], pauseSec: number): WordTiming[] {
  return words.map((w) => {
    const before = points.filter((p) => p <= w.start + 1e-6).length;
    return { ...w, start: w.start + before * pauseSec, end: w.end + before * pauseSec };
  });
}

/**
 * ffmpeg filter graph that splits the audio at `points` and pads each piece but the last, by
 * `pauseSec` (one length for all, or one per point).
 */
export function pauseFilter(points: number[], pauseSec: number | number[]): string {
  const n = points.length + 1;
  const labels = Array.from({ length: n }, (_, i) => `a${i}`);
  const parts = [`[0:a]asplit=${n}${labels.map((l) => `[${l}]`).join('')}`];
  const bounds = [0, ...points];
  bounds.forEach((start, i) => {
    const end = points[i];
    const trim = end === undefined ? `atrim=start=${start}` : `atrim=start=${start}:end=${end}`;
    const pad = end === undefined ? '' : `,apad=pad_dur=${Array.isArray(pauseSec) ? pauseSec[i] : pauseSec}`;
    parts.push(`[a${i}]${trim},asetpts=PTS-STARTPTS${pad}[s${i}]`);
  });
  parts.push(`${labels.map((_, i) => `[s${i}]`).join('')}concat=n=${n}:v=0:a=1[out]`);
  return parts.join(';');
}

/** Adds a pause after every sentence of a voiced beat (see addPacingPauses). */
export async function addSentencePauses(args: {
  bytes: Uint8Array;
  narration: string;
  providerWords?: WordTiming[];
  pauseSec: number;
}): Promise<{ bytes: Uint8Array; providerWords?: WordTiming[]; pauses: number }> {
  return addPacingPauses({ ...args, sentencePauseSec: args.pauseSec, dramaticPauseSec: 0 });
}

/**
 * Adds sentence pauses and pacing-mark pauses to a voiced beat. Needs the voice's word timings
 * (Kokoro provides them); without them the audio is returned unchanged. Returns the new audio
 * and the provider's word timings shifted to match.
 */
export async function addPacingPauses(args: {
  bytes: Uint8Array;
  narration: string;
  providerWords?: WordTiming[];
  sentencePauseSec: number;
  dramaticPauseSec: number;
}): Promise<{ bytes: Uint8Array; providerWords?: WordTiming[]; pauses: number }> {
  const { bytes, narration, providerWords, sentencePauseSec, dramaticPauseSec } = args;
  if (!providerWords?.length || (sentencePauseSec <= 0 && dramaticPauseSec <= 0)) return { bytes, providerWords, pauses: 0 };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pauses-'));
  try {
    const input = path.join(dir, 'in.mp3');
    const output = path.join(dir, 'out.mp3');
    await fs.writeFile(input, bytes);
    const durationSec = (await getAudioDurationMs(input)) / 1000;
    const points = pacingPausePoints(narration, alignWordTimings(narration, providerWords, durationSec), {
      sentencePauseSec,
      dramaticPauseSec,
    }).filter((p) => p.at > 0.05 && p.at < durationSec - 0.05);
    if (points.length === 0) return { bytes, providerWords, pauses: 0 };

    await execFileAsync(getFfmpegPath(), [
      '-y', '-v', 'error', '-i', input,
      '-filter_complex', pauseFilter(points.map((p) => p.at), points.map((p) => p.sec)),
      '-map', '[out]', '-c:a', 'libmp3lame', '-q:a', '2', output,
    ]);
    return {
      bytes: new Uint8Array(await fs.readFile(output)),
      providerWords: shiftWordsForPausePoints(providerWords, points),
      pauses: points.length,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
