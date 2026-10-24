import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);

/**
 * Cuts on the beat. The cuts follow the narration's words, so they stay where they are; the
 * music slides under them instead: each piece of music starts at the offset (within one beat)
 * that puts the most cuts on a beat. Beats come from the track's onsets: tempo by
 * autocorrelation, then the phase that best fits the onsets.
 */

export interface BeatGrid {
  /** Seconds between beats. */
  periodSec: number;
  /** Where the first beat falls (seconds into the track, below periodSec). */
  phaseSec: number;
  /** How regular the beat is (0-1); ambient music without a pulse scores low and is left alone. */
  confidence: number;
}

const RATE = 11025;
const HOP = 128;
const HOP_SEC = HOP / RATE;
const MIN_BPM = 70;
const MAX_BPM = 180;
/** Below this the music has no clear pulse to cut on. */
export const MIN_CONFIDENCE = 0.2;
/** Grid version: bumped when detection changes, so cached grids are worked out again. */
const GRID_VERSION = 1;

/** The onset strength over time (rises in loudness), one value per HOP samples. */
export function onsetEnvelope(samples: Int16Array): Float32Array {
  const frames = Math.floor(samples.length / HOP);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) sum += (samples[i] / 32768) ** 2;
    energy[f] = Math.log1p(1000 * sum);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
  // Remove the slow trend, so only the attacks count
  const out = new Float32Array(frames);
  const w = 16;
  for (let f = 0; f < frames; f++) {
    let mean = 0;
    let n = 0;
    for (let j = Math.max(0, f - w); j <= Math.min(frames - 1, f + w); j++) {
      mean += onset[j];
      n++;
    }
    out[f] = Math.max(0, onset[f] - mean / n);
  }
  return out;
}

/** Tempo and phase from an onset envelope. */
export function beatGridFromEnvelope(env: Float32Array): BeatGrid | null {
  const minLag = Math.round(60 / MAX_BPM / HOP_SEC);
  const maxLag = Math.round(60 / MIN_BPM / HOP_SEC);
  if (env.length < maxLag * 4) return null;
  let zero = 0;
  for (let i = 0; i < env.length; i++) zero += env[i] * env[i];
  if (zero <= 0) return null;
  let bestLag = 0;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    // A light preference for 90-140 BPM, where most music sits, so a half or double tempo doesn't win on noise
    const bpm = 60 / (lag * HOP_SEC);
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.9) ** 2);
    if (s * weight > best) {
      best = s * weight;
      bestLag = lag;
    }
  }
  if (!bestLag) return null;
  let raw = 0;
  for (let i = bestLag; i < env.length; i++) raw += env[i] * env[i - bestLag];
  const confidence = Math.max(0, Math.min(1, raw / zero));
  // Phase: the offset whose beats sit on the most onset strength
  let bestPhase = 0;
  let phaseScore = -1;
  for (let p = 0; p < bestLag; p++) {
    let s = 0;
    for (let i = p; i < env.length; i += bestLag) s += env[i] + 0.5 * ((env[i - 1] ?? 0) + (env[i + 1] ?? 0));
    if (s > phaseScore) {
      phaseScore = s;
      bestPhase = p;
    }
  }
  return { periodSec: bestLag * HOP_SEC, phaseSec: bestPhase * HOP_SEC, confidence: Math.round(confidence * 1000) / 1000 };
}

/** A track's beat grid (from its first two minutes), cached next to it. */
export async function detectBeatGrid(trackPath: string): Promise<BeatGrid | null> {
  const cache = `${trackPath}.beats.json`;
  try {
    const cached = JSON.parse(await fs.readFile(cache, 'utf-8')) as { version: number; grid: BeatGrid | null };
    if (cached.version === GRID_VERSION) return cached.grid;
  } catch {
    // not worked out yet
  }
  const { stdout } = await execFileAsync(
    getFfmpegPath(),
    ['-v', 'error', '-t', '120', '-i', trackPath, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  const grid = beatGridFromEnvelope(onsetEnvelope(samples));
  await fs.writeFile(cache, JSON.stringify({ version: GRID_VERSION, grid }), 'utf-8').catch(() => {});
  return grid;
}

/**
 * Where to start the music (seconds into the track, below one beat) so the most cuts land on a
 * beat. `cutsSec` are the cuts while this music plays, from when it starts.
 */
export function bestMusicOffset(cutsSec: number[], grid: BeatGrid): number {
  if (!cutsSec.length) return 0;
  const { periodSec, phaseSec } = grid;
  const sigma = Math.min(0.06, periodSec / 6);
  let best = 0;
  let bestScore = -1;
  for (let o = 0; o < periodSec; o += 0.01) {
    let score = 0;
    for (const c of cutsSec) {
      const d = (((c + o - phaseSec) % periodSec) + periodSec) % periodSec;
      const dist = Math.min(d, periodSec - d);
      score += Math.exp(-0.5 * (dist / sigma) ** 2);
    }
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = o;
    }
  }
  return Math.round(best * 1000) / 1000;
}

/** How many cuts land within `toleranceSec` of a beat with this offset (for logs and tests). */
export function cutsOnBeat(cutsSec: number[], grid: BeatGrid, offsetSec: number, toleranceSec = 0.07): number {
  return cutsSec.filter((c) => {
    const d = (((c + offsetSec - grid.phaseSec) % grid.periodSec) + grid.periodSec) % grid.periodSec;
    return Math.min(d, grid.periodSec - d) <= toleranceSec;
  }).length;
}

/**
 * Every cut in the programme (seconds): where each beat starts, and where each shot starts
 * inside a composed beat (from its shot record).
 */
export async function programCuts(
  scenes: Array<{ sceneStartMs: number; trackPath: string | null }>,
  readShots: (trackPath: string) => Promise<{ shots: Array<{ startSec: number }> } | null>,
): Promise<number[]> {
  const cuts: number[] = [];
  for (const scene of scenes) {
    if (scene.sceneStartMs > 0) cuts.push(scene.sceneStartMs / 1000);
    if (!scene.trackPath) continue;
    const record = await readShots(scene.trackPath).catch(() => null);
    for (const shot of record?.shots.slice(1) ?? []) cuts.push(scene.sceneStartMs / 1000 + shot.startSec);
  }
  return cuts.sort((a, b) => a - b);
}
