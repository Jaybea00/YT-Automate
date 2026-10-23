import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '../providers/registry';
import type { LLMProvider } from '../providers/types';
import type { WordTiming } from '../tts/word-timings';
import { BED_SOUND_IDS, MOMENT_SOUND_IDS, REAL_SOUNDS, prepareRealSound, type RealSoundId } from './real-sfx';
import type { BedCue, SoundCue } from './sound-design';

/**
 * Narration-triggered sounds: the few lines that describe something you'd hear ("he fires two
 * shots", "the crowd erupts") get the real sound, placed on the word that says it. Stretches set
 * somewhere you could hear (a stadium, a battlefield, rain) get a quiet ambience bed. Planned once
 * per script text and saved, so re-assembling doesn't re-plan.
 */

export type Intensity = 'soft' | 'normal' | 'strong';

export interface SoundMoment {
  beat_index: number;
  /** The words in the beat the sound lands on. */
  trigger: string;
  sound: RealSoundId;
  intensity: Intensity;
}

export interface AmbienceBed {
  start_beat: number;
  /** Inclusive. */
  end_beat: number;
  sound: RealSoundId;
}

export interface SoundMomentPlan {
  textHash: string;
  plannedAt: string;
  moments: SoundMoment[];
  beds?: AmbienceBed[];
  /** 2 once beds are planned; older plans are made again. */
  version?: number;
}

export const PLAN_VERSION = 2;
/** Beds run at least this many beats (shorter stretches aren't worth a bed). */
const MIN_BED_BEATS = 2;
const BED_FADE_MS = 1500;

const INTENSITY_GAIN: Record<Intensity, number> = { soft: 0.6, normal: 1, strong: 1.3 };
/** About one sound per 70 words of narration (roughly every 30 seconds), never fewer than 2. */
const WORDS_PER_MOMENT = 70;

const MomentsSchema = z.object({
  moments: z.array(z.object({ beat_index: z.number(), trigger: z.string(), sound: z.string(), intensity: z.string().optional() })),
  beds: z.array(z.object({ start_beat: z.number(), end_beat: z.number(), sound: z.string() })).optional(),
});

type Beat = { index: number; text: string };

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);

export function narrationHash(beats: Beat[]): string {
  return createHash('sha1').update(beats.map((b) => `${b.index}:${b.text}`).join('\n')).digest('hex').slice(0, 16);
}

export function maxMoments(beats: Beat[]): number {
  const words = beats.reduce((n, b) => n + tokens(b.text).length, 0);
  return Math.max(2, Math.round(words / WORDS_PER_MOMENT));
}

export function buildMomentsPrompt(beats: Beat[], style?: string | null): string {
  return `Pick sound effects for a${style ? ` ${style}` : ''} documentary narration. A real recorded sound plays on the exact word a line describes it.
Only choose lines that literally describe an audible event happening in the story: a shot fired, an explosion, a crowd erupting, a whistle, a door slamming. Never for metaphors ("the market exploded", "a bombshell report"), never for things merely mentioned or in general statements.
Keep it sparing and tasteful: at most ${maxMoments(beats)} sounds, at most one per beat, the strongest moments only. For violence, one restrained sound, not a barrage.
For each: beat_index; trigger: the exact word or 2-3 words in that beat where the sound should land (the action word, e.g. "fires", "erupts"); sound: one id from the list; intensity: "soft", "normal" or "strong".

SOUNDS:
${MOMENT_SOUND_IDS.map((id) => `- ${id}: ${REAL_SOUNDS[id].label}`).join('\n')}

Also choose ambience beds: a quiet background sound under a run of consecutive beats set somewhere you'd hear it (a match in a stadium, a battle, a storm, a city at night). Only where the place is clear from the narration; at most ${maxBeds(beats)} beds, each at least ${MIN_BED_BEATS} beats, not overlapping. Leave reflective or explanatory stretches without one.
For each: start_beat, end_beat (inclusive), sound: one id from this list:
${BED_SOUND_IDS.map((id) => `- ${id}: ${REAL_SOUNDS[id].label}`).join('\n')}

NARRATION (beat index, text):
${beats.map((b) => `[${b.index}] ${b.text}`).join('\n')}

Return {"moments": [], "beds": []} when nothing in the narration makes a sound.`;
}

/**
 * Word position of `trigger` in the beat's text, or -1. Counted over every space-separated
 * token (as word timings are), so free-standing punctuation like "…" keeps its place.
 */
export function triggerWordIndex(text: string, trigger: string): number {
  const words = text
    .trim()
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  const want = tokens(trigger);
  if (want.length === 0) return -1;
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((w, k) => words[i + k] === w)) return i;
  }
  return -1;
}

export function normalizeMoments(raw: z.infer<typeof MomentsSchema>['moments'], beats: Beat[]): SoundMoment[] {
  const byIndex = new Map(beats.map((b) => [b.index, b]));
  const used = new Set<number>();
  const out: SoundMoment[] = [];
  for (const m of raw) {
    const beat = byIndex.get(m.beat_index);
    const sound = m.sound.trim().toLowerCase();
    if (!beat || used.has(beat.index) || !isMomentSound(sound) || triggerWordIndex(beat.text, m.trigger) < 0) continue;
    used.add(beat.index);
    const intensity = (['soft', 'normal', 'strong'] as const).find((i) => i === m.intensity?.trim().toLowerCase()) ?? 'normal';
    out.push({ beat_index: beat.index, trigger: m.trigger.trim(), sound, intensity });
  }
  return out.slice(0, maxMoments(beats)).sort((a, b) => a.beat_index - b.beat_index);
}

const isMomentSound = (s: string): s is RealSoundId => (MOMENT_SOUND_IDS as string[]).includes(s);
const isBedSound = (s: string): s is RealSoundId => (BED_SOUND_IDS as string[]).includes(s);

/** About one bed per eight beats. */
export function maxBeds(beats: Beat[]): number {
  return Math.max(1, Math.round(beats.length / 8));
}

/** Beds over real beats, long enough, in order, without overlaps. */
export function normalizeBeds(raw: NonNullable<z.infer<typeof MomentsSchema>['beds']>, beats: Beat[]): AmbienceBed[] {
  const order = beats.map((b) => b.index);
  const pos = (i: number) => order.indexOf(i);
  const out: AmbienceBed[] = [];
  for (const b of [...raw].sort((x, y) => pos(x.start_beat) - pos(y.start_beat))) {
    const sound = b.sound.trim().toLowerCase();
    const s = pos(b.start_beat);
    const e = pos(b.end_beat);
    if (!isBedSound(sound) || s < 0 || e < 0 || e - s + 1 < MIN_BED_BEATS) continue;
    if (out.some((o) => s <= pos(o.end_beat))) continue;
    out.push({ start_beat: b.start_beat, end_beat: b.end_beat, sound });
  }
  return out.slice(0, maxBeds(beats));
}

/** Bed spans in the video: from the first scene's start to the last scene's end, faded at both ends. */
export function bedCues(
  beds: AmbienceBed[],
  scenes: Record<number, { startMs: number; endMs: number }>,
  files: Partial<Record<RealSoundId, string>>,
): BedCue[] {
  const out: BedCue[] = [];
  for (const bed of beds) {
    const first = scenes[bed.start_beat];
    const last = scenes[bed.end_beat];
    const file = files[bed.sound];
    if (!first || !last || !file || last.endMs <= first.startMs) continue;
    out.push({ startMs: first.startMs, endMs: last.endMs, file, gain: REAL_SOUNDS[bed.sound].gain, fadeMs: BED_FADE_MS });
  }
  return out;
}

export async function planSoundMoments(supabase: SupabaseClient, beats: Beat[], style?: string | null): Promise<SoundMomentPlan> {
  const textHash = narrationHash(beats);
  const { provider, ctx } = await resolveForStage<LLMProvider>('script', supabase);
  const { data } = await provider.generateJson(
    {
      system: 'You are a documentary sound designer. You use real sound effects sparingly, only where the story makes a sound.',
      prompt: buildMomentsPrompt(beats, style),
      schema: MomentsSchema,
    },
    ctx,
  );
  return {
    textHash,
    plannedAt: new Date().toISOString(),
    moments: normalizeMoments(data.moments, beats),
    beds: normalizeBeds(data.beds ?? [], beats),
    version: PLAN_VERSION,
  };
}

/**
 * Turns moments into cues: each lands at the start of its trigger word, from the beat's word
 * timings (relative to its voice) and where that voice starts in the video. Moments whose word
 * can't be timed, or whose sound isn't available, are skipped.
 */
export function momentCues(
  moments: SoundMoment[],
  beats: Beat[],
  words: Record<number, WordTiming[]>,
  voiceStartMs: Record<number, number>,
  files: Partial<Record<RealSoundId, string>>,
): SoundCue[] {
  const cues: SoundCue[] = [];
  for (const m of moments) {
    const beat = beats.find((b) => b.index === m.beat_index);
    const timings = words[m.beat_index];
    const start = voiceStartMs[m.beat_index];
    const file = files[m.sound];
    if (!beat || !timings?.length || start === undefined || !file) continue;
    const at = triggerWordIndex(beat.text, m.trigger);
    const word = timings[at];
    if (!word) continue;
    cues.push({ atMs: Math.round(start + word.start * 1000), sound: `real:${m.sound}`, file, gain: REAL_SOUNDS[m.sound].gain * INTENSITY_GAIN[m.intensity] });
  }
  return cues;
}

/** Prepares each sound the moments and beds need; missing ones are left out. */
export async function prepareMomentSounds(moments: Array<{ sound: RealSoundId }>): Promise<Partial<Record<RealSoundId, string>>> {
  const files: Partial<Record<RealSoundId, string>> = {};
  for (const id of [...new Set(moments.map((m) => m.sound))]) {
    const file = await prepareRealSound(id);
    if (file) files[id] = file;
    else console.warn(`[SFX] No recording for "${id}" (add one to storage/sfx/real/${id}/ or set FREESOUND_API_KEY); that moment is skipped`);
  }
  return files;
}
