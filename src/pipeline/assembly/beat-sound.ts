import type { BeatPacing } from './pacing';

/**
 * Per-beat sound controls from Vibedit (script_json.beat_sound, by beat index):
 *  - music: the music's level under this beat, as a multiple of the normal level
 *    (0 silent, 0.5 quieter, 1.5 louder), eased in and out at the beat's edges
 *  - muteSfx: no sound effects during this beat
 *  - pauseAfterSec: a dramatic silence after the line: the beat holds this much longer before
 *    the next one, and the music dips under it
 */
export interface BeatSound {
  music?: number;
  muteSfx?: boolean;
  pauseAfterSec?: number;
}

export type BeatSounds = Record<number, BeatSound>;

export const MAX_PAUSE_SEC = 4;
const MAX_MUSIC = 2;
/** Music under a dramatic pause, as a multiple of the normal level. */
const PAUSE_MUSIC = 0.15;
const RAMP_SEC = 0.4;

/** A submitted control kept sane; null when it changes nothing. */
export function normalizeBeatSound(raw: unknown): BeatSound | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: BeatSound = {};
  const music = Number(r.music);
  if (r.music !== undefined && r.music !== null && Number.isFinite(music) && Math.abs(music - 1) > 0.001) {
    out.music = Math.round(Math.max(0, Math.min(MAX_MUSIC, music)) * 100) / 100;
  }
  if (r.muteSfx === true) out.muteSfx = true;
  const pause = Number(r.pauseAfterSec);
  if (Number.isFinite(pause) && pause > 0) out.pauseAfterSec = Math.round(Math.min(MAX_PAUSE_SEC, pause) * 10) / 10;
  return Object.keys(out).length ? out : null;
}

/** All controls from script_json, cleaned (unknown or empty ones dropped). */
export function readBeatSounds(raw: unknown): BeatSounds {
  const out: BeatSounds = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(k);
    const control = normalizeBeatSound(v);
    if (Number.isInteger(index) && index >= 0 && control) out[index] = control;
  }
  return out;
}

/** The pacing with each beat's dramatic pause added to its tail. */
export function withPauses(pacing: Map<number, BeatPacing>, sounds: BeatSounds): Map<number, BeatPacing> {
  const out = new Map(pacing);
  for (const [k, s] of Object.entries(sounds)) {
    const index = Number(k);
    const p = out.get(index);
    if (p && s.pauseAfterSec) out.set(index, { ...p, tailSec: p.tailSec + s.pauseAfterSec });
  }
  return out;
}

const r = (n: number) => Number(n.toFixed(3));

/**
 * The music's per-beat levels and pause dips as a volume expression over t (seconds), to multiply
 * with the music accents. Each level eases in and out over RAMP_SEC at the beat's edges.
 */
export function beatMusicExpression(
  sounds: BeatSounds,
  scenes: Array<{ index: number; startSec: number; endSec: number }>,
): string {
  const parts: string[] = [];
  const window = (a: number, b: number) =>
    `min(max(0,min(1,(t-${r(a)})/${RAMP_SEC})),max(0,min(1,(${r(b)}-t)/${RAMP_SEC})))`;
  for (const scene of scenes) {
    const s = sounds[scene.index];
    if (!s) continue;
    if (s.music !== undefined) parts.push(`(1+(${r(s.music - 1)})*${window(scene.startSec, scene.endSec)})`);
    if (s.pauseAfterSec) {
      const start = Math.max(scene.startSec, scene.endSec - s.pauseAfterSec);
      parts.push(`(1-${r(1 - PAUSE_MUSIC)}*${window(start, scene.endSec + RAMP_SEC)})`);
    }
  }
  return parts.join('*');
}

/** Sound effects without the ones in beats whose effects are muted. */
export function withoutMutedSfx<T extends { atMs: number }>(
  cues: T[],
  sounds: BeatSounds,
  scenes: Array<{ index: number; startMs: number; endMs: number }>,
): T[] {
  const muted = scenes.filter((s) => sounds[s.index]?.muteSfx);
  if (!muted.length) return cues;
  return cues.filter((c) => !muted.some((s) => c.atMs >= s.startMs && c.atMs < s.endMs));
}
