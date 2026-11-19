import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { directionWithMood, isDeliveryMood, moodSpeed, type DeliveryMood } from '@/lib/script/delivery-moods';
import { resolveForStage, type ResolvedStageProvider } from '../providers/registry';
import type { TTSProvider, TtsResult } from '../providers/types';
import { runJobUnit, type UnitRunResult } from '../runner/unit-runner';
import { detectSilences, getAudioDurationMs, getFfmpegPath } from '../utils/ffmpeg';
import { deliveryForStyle } from './delivery';
import { loadPronunciations } from './pronunciations';
import { toSpeakableText, type Pronunciation } from './speakable';
import { addPacingPauses } from './pauses';
import {
  alignWordTimings,
  estimateWordTimings,
  loadWordTimings,
  saveWordTimings,
  type WordTiming,
} from './word-timings';

const execFileAsync = promisify(execFile);

/** Everything needed to voice beats for one job: provider, voice, delivery and pronunciations. */
export interface TtsSetup {
  resolved: ResolvedStageProvider<TTSProvider>;
  voiceId: string;
  direction?: string;
  pronunciations: Pronunciation[];
  /** Documentary pacing fixed on the job when it was created (absent: the voice's normal pace). */
  pacing?: { speed: number; sentencePauseSec: number };
  /** Pause for each pacing mark (an ellipsis), fixed on the job (absent on older jobs: none). */
  dramaticPauseSec?: number;
}

/** A pacing mark in the narration: an ellipsis the writer put in for a dramatic pause. */
export const PACING_MARK = /…|\.\.\./;

interface JobVoiceFields {
  tts_provider_config_id?: string | null;
  voice_id?: string | null;
  voice_override?: string | null;
  narration_pacing?: { speed?: unknown; sentencePauseSec?: unknown } | null;
  dramatic_pause_sec?: unknown;
  /** How the narrator should sound, fixed on the job (from the video's composed style). */
  delivery?: unknown;
}

function jobDramaticPause(script: JobVoiceFields): number | undefined {
  const sec = Number(script.dramatic_pause_sec);
  return sec > 0 && sec <= 3 ? sec : undefined;
}

/** The job's pacing, if valid; jobs created before pacing existed have none. */
function jobPacing(script: JobVoiceFields): TtsSetup['pacing'] {
  const p = script.narration_pacing;
  const speed = Number(p?.speed);
  const sentencePauseSec = Number(p?.sentencePauseSec);
  if (!p || !(speed > 0.5 && speed <= 1.5) || !(sentencePauseSec >= 0 && sentencePauseSec <= 2)) return undefined;
  return { speed, sentencePauseSec };
}

/**
 * Resolves the TTS setup the same way for full voicing runs and single-beat re-voicing:
 * the narrator chosen for the job (config + voice) wins over the stage binding.
 */
export async function resolveTtsSetup(
  supabase: SupabaseClient,
  job: { template?: string | null; script?: unknown } & JobVoiceFields,
): Promise<TtsSetup> {
  const script = (job.script ?? {}) as JobVoiceFields;
  const overrideConfigId = job.tts_provider_config_id || script.tts_provider_config_id || undefined;
  const voiceOverride = job.voice_id || script.voice_id || script.voice_override || undefined;

  const resolved = await resolveForStage<TTSProvider>('tts', supabase, overrideConfigId, voiceOverride);
  const voiceId = (resolved.options.voiceId as string) || (resolved.options.voice as string) || 'alloy';
  return {
    resolved,
    voiceId,
    // Opt-in per voice config: measured on Gemini, any instruction slows narration well below
    // the pace scripts are planned for, so plain narration is the default
    direction: resolved.options.styleDirection === true ? (typeof script.delivery === 'string' && script.delivery.trim() ? script.delivery : deliveryForStyle(job.template)) : undefined,
    pronunciations: await loadPronunciations(),
    pacing: jobPacing(script),
    dramaticPauseSec: jobDramaticPause(script),
  };
}

/**
 * The checkpoint input for a beat. It holds what is actually voiced, so a changed
 * pronunciation re-voices just the affected beats; direction only counts for voices that use it.
 */
export function ttsUnitInput(setup: TtsSetup, narration: string): { spokenText: string; input: Record<string, unknown> } {
  const spokenText = toSpeakableText(narration, setup.pronunciations);
  const input: Record<string, unknown> = { text: spokenText, voiceId: setup.voiceId };
  if (setup.direction && setup.resolved.provider.supportsDirection) input.direction = setup.direction;
  // Only paced jobs carry it, so other videos' voicing checkpoints are unchanged
  if (setup.pacing) input.pacing = setup.pacing;
  // Likewise only beats with a pacing mark, on jobs that honour them
  if (setup.dramaticPauseSec && PACING_MARK.test(spokenText)) input.dramaticPauseSec = setup.dramaticPauseSec;
  return { spokenText, input };
}

/**
 * A chosen take: the best of several voicings of this beat (see retake.ts), kept while the
 * spoken text and the voice are the same as when it was made.
 */
export interface BeatTake {
  path: string;
  durationMs: number;
  /** What the voice was given; a changed beat or pronunciation no longer matches. */
  spokenText: string;
  /** The voice, delivery and pace it was made with (voiceKeyOf). */
  voiceKey: string;
  words?: WordTiming[];
}

/** A quote inside the beat voiced by another narrator (a character), by its exact words. */
export interface BeatPart {
  text: string;
  narratorId: string;
  speaker?: string;
}

/**
 * One beat's own voice settings (script_json.beat_voice, by beat index):
 *  - speed: a multiple of the job's pace (0.75 slower ... 1.25 faster)
 *  - narratorId: another narrator for this line (a quote, a different speaker)
 *  - recorded: the creator's own recording, used instead of a synthesized voice
 *  - mood: how the line is delivered (tense, quiet, reveal...)
 *  - take: the best of several voicings, chosen by the listen-back check
 *  - parts: quotes inside the beat voiced by characters' narrators
 */
export interface BeatVoice {
  speed?: number;
  narratorId?: string;
  recorded?: { path: string; durationMs: number };
  mood?: DeliveryMood;
  take?: BeatTake;
  parts?: BeatPart[];
}

const validWords = (raw: unknown): WordTiming[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const words = raw.filter((w): w is WordTiming => typeof w?.word === 'string' && Number.isFinite(w?.start) && Number.isFinite(w?.end));
  return words.length ? words : undefined;
};

/** A submitted setting kept sane; null when it changes nothing. */
export function normalizeBeatVoice(raw: unknown): BeatVoice | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: BeatVoice = {};
  const speed = Number(r.speed);
  if (r.speed !== undefined && r.speed !== null && Number.isFinite(speed) && Math.abs(speed - 1) > 0.001) {
    out.speed = Math.round(Math.max(0.6, Math.min(1.5, speed)) * 100) / 100;
  }
  if (typeof r.narratorId === 'string' && /^[\w-]{1,80}$/.test(r.narratorId)) out.narratorId = r.narratorId;
  const rec = r.recorded as { path?: unknown; durationMs?: unknown } | undefined;
  if (rec && typeof rec.path === 'string' && Number(rec.durationMs) > 0) out.recorded = { path: rec.path, durationMs: Math.round(Number(rec.durationMs)) };
  if (isDeliveryMood(r.mood) && r.mood !== 'neutral') out.mood = r.mood;
  const take = r.take as Partial<BeatTake> | undefined;
  if (take && typeof take.path === 'string' && Number(take.durationMs) > 0 && typeof take.spokenText === 'string' && typeof take.voiceKey === 'string') {
    const words = validWords(take.words);
    out.take = { path: take.path, durationMs: Math.round(Number(take.durationMs)), spokenText: take.spokenText, voiceKey: take.voiceKey, ...(words ? { words } : {}) };
  }
  if (Array.isArray(r.parts)) {
    const parts = (r.parts as Array<Partial<BeatPart>>)
      .filter((p) => typeof p?.text === 'string' && p.text.trim() && p.text.length <= 600 && typeof p.narratorId === 'string' && /^[\w-]{1,80}$/.test(p.narratorId))
      .slice(0, 6)
      .map((p) => ({ text: p.text!.trim(), narratorId: p.narratorId!, ...(typeof p.speaker === 'string' && p.speaker.trim() ? { speaker: p.speaker.trim().slice(0, 60) } : {}) }));
    if (parts.length) out.parts = parts;
  }
  return Object.keys(out).length ? out : null;
}

export function readBeatVoices(raw: unknown): Record<number, BeatVoice> {
  const out: Record<number, BeatVoice> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const i = Number(k);
    const voice = normalizeBeatVoice(v);
    if (Number.isInteger(i) && i >= 0 && voice) out[i] = voice;
  }
  return out;
}

/** The setup with another narrator's voice (a character, a second speaker). */
export async function withNarrator(supabase: SupabaseClient, setup: TtsSetup, narratorId: string): Promise<TtsSetup> {
  const { data: narrator } = await supabase.from('narrators').select('provider_config_id, voice_id').eq('id', narratorId).maybeSingle();
  if (!narrator) throw new Error('That narrator no longer exists');
  const resolved = await resolveForStage<TTSProvider>('tts', supabase, narrator.provider_config_id ?? undefined, narrator.voice_id ?? undefined);
  return { ...setup, resolved, voiceId: (resolved.options.voiceId as string) || (resolved.options.voice as string) || narrator.voice_id || setup.voiceId };
}

/** The setup at a pace multiple of the job's own. */
export function withSpeed(setup: TtsSetup, base: TtsSetup, multiple: number): TtsSetup {
  if (Math.abs(multiple - 1) < 0.001) return setup;
  return { ...setup, pacing: { speed: Math.round((base.pacing?.speed ?? 1) * multiple * 100) / 100, sentencePauseSec: base.pacing?.sentencePauseSec ?? 0 } };
}

/**
 * The setup for one beat: its own narrator, its pace (a set speed wins over the mood's), and its
 * mood as direction for voices that take direction.
 */
export async function setupForBeat(supabase: SupabaseClient, base: TtsSetup, voice: BeatVoice | undefined): Promise<TtsSetup> {
  if (!voice || (!voice.speed && !voice.narratorId && !voice.mood)) return base;
  let setup = base;
  if (voice.narratorId) setup = await withNarrator(supabase, setup, voice.narratorId);
  setup = withSpeed(setup, base, voice.speed ?? moodSpeed(voice.mood));
  if (voice.mood && setup.resolved.provider.supportsDirection) setup = { ...setup, direction: directionWithMood(setup.direction, voice.mood) };
  return setup;
}

/** What a voicing depends on besides the text: provider, voice, delivery and pace. */
export function voiceKeyOf(setup: TtsSetup): string {
  return JSON.stringify([
    setup.resolved.providerId,
    setup.resolved.configId,
    setup.voiceId,
    setup.resolved.provider.supportsDirection ? (setup.direction ?? '') : '',
    setup.pacing?.speed ?? 1,
    setup.pacing?.sentencePauseSec ?? 0,
    setup.dramaticPauseSec ?? 0,
  ]);
}

/**
 * Voices spoken text with a setup: the voice itself, then a breath after each sentence and a
 * longer pause at each pacing mark (placed from the voice's own word timings).
 */
export async function synthesizeSpoken(setup: TtsSetup, spokenText: string, unitIndex = 0): Promise<TtsResult> {
  const { provider, ctx } = setup.resolved;
  const synthesized = await provider.synthesize(
    { text: spokenText, voiceId: setup.voiceId, format: 'mp3', direction: setup.direction, speed: setup.pacing?.speed },
    ctx,
  );
  const sentencePauseSec = setup.pacing?.sentencePauseSec ?? 0;
  const dramaticPauseSec = PACING_MARK.test(spokenText) ? (setup.dramaticPauseSec ?? 0) : 0;
  if ((!sentencePauseSec && !dramaticPauseSec) || synthesized.mimeType?.includes('wav')) return synthesized;
  try {
    const paused = await addPacingPauses({ bytes: synthesized.bytes, narration: spokenText, providerWords: synthesized.words, sentencePauseSec, dramaticPauseSec });
    return { ...synthesized, bytes: paused.bytes, words: paused.providerWords };
  } catch (err) {
    console.warn(`[voiceBeat] Beat ${unitIndex}: sentence pauses skipped (${err instanceof Error ? err.message.slice(0, 160) : err})`);
    return synthesized;
  }
}

// --------------------------------------------------------------------------
// Characters: quotes inside a beat voiced by other narrators
// --------------------------------------------------------------------------

export interface NarrationSegment {
  text: string;
  /** The character's narrator for a quote; absent for the beat's own narrator. */
  part?: BeatPart;
}

/**
 * The beat's narration split around its character quotes, in order. A quote not found word for
 * word in the narration (the beat was edited) is skipped, so it's voiced by the narrator.
 */
export function splitNarration(narration: string, parts: BeatPart[] | undefined): NarrationSegment[] {
  if (!parts?.length) return [{ text: narration }];
  const segments: NarrationSegment[] = [];
  let cursor = 0;
  const found = parts
    .map((part) => ({ part, at: narration.indexOf(part.text) }))
    .filter((p) => p.at >= 0)
    .sort((a, b) => a.at - b.at);
  for (const { part, at } of found) {
    if (at < cursor) continue; // overlaps the previous quote
    const before = narration.slice(cursor, at).trim();
    if (before) segments.push({ text: before });
    segments.push({ text: part.text, part });
    cursor = at + part.text.length;
  }
  const rest = narration.slice(cursor).trim();
  if (rest) segments.push({ text: rest });
  return segments.length ? segments : [{ text: narration }];
}

/** Gap between a narrator's line and a character's quote. */
const PART_GAP_SEC = 0.18;

/** Joins voiced segments with a short gap, shifting each segment's word timings to match. */
export async function joinSegments(pieces: Array<{ bytes: Uint8Array; words?: WordTiming[] }>): Promise<{ bytes: Uint8Array; words?: WordTiming[] }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'parts-'));
  try {
    const files: string[] = [];
    const durations: number[] = [];
    for (const [i, p] of pieces.entries()) {
      const f = path.join(dir, `p${i}.mp3`);
      await writeFile(f, p.bytes);
      files.push(f);
      durations.push((await getAudioDurationMs(f)) / 1000);
    }
    const inputs = files.flatMap((f) => ['-i', f]);
    const chain = files.map((_, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=mono${i < files.length - 1 ? `,apad=pad_dur=${PART_GAP_SEC}` : ''}[s${i}]`).join(';');
    const out = path.join(dir, 'joined.mp3');
    await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', ...inputs, '-filter_complex', `${chain};${files.map((_, i) => `[s${i}]`).join('')}concat=n=${files.length}:v=0:a=1[a]`, '-map', '[a]', '-c:a', 'libmp3lame', '-b:a', '160k', out]);
    let offset = 0;
    const words: WordTiming[] = [];
    let allTimed = true;
    pieces.forEach((p, i) => {
      if (!p.words?.length) allTimed = false;
      else words.push(...p.words.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset })));
      offset += durations[i] + (i < pieces.length - 1 ? PART_GAP_SEC : 0);
    });
    return { bytes: new Uint8Array(await readFile(out)), words: allTimed ? words : undefined };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface VoiceBeatOptions {
  supabase: SupabaseClient;
  setup: TtsSetup;
  jobId: string;
  unitIndex: number;
  narration: string;
  outputDir: string;
  signal?: AbortSignal;
  /** This beat's own voice settings (speed, narrator, the creator's recording). */
  beatVoice?: BeatVoice;
}

/** Voices one beat through the checkpointed unit runner and saves its word timings. */
export async function voiceBeat(options: VoiceBeatOptions): Promise<UnitRunResult> {
  const { supabase, jobId, unitIndex, narration, outputDir, signal, beatVoice } = options;
  const recorded = beatVoice?.recorded;
  const setup = recorded ? options.setup : await setupForBeat(supabase, options.setup, beatVoice);
  const { ctx, maxRetries, configId, providerId, model, options: providerOptions } = setup.resolved;
  const segments = recorded ? [{ text: narration }] : splitNarration(narration, beatVoice?.parts);
  const hasParts = segments.some((s) => s.part);
  const voiced = ttsUnitInput(setup, narration);
  const spokenText = hasParts ? segments.map((s) => toSpeakableText(s.text, setup.pronunciations)).join(' ') : voiced.spokenText;
  // A chosen take stands in for a fresh voicing while it's still the same words and voice
  const take = !recorded && !hasParts && beatVoice?.take && beatVoice.take.spokenText === spokenText && beatVoice.take.voiceKey === voiceKeyOf(setup) ? beatVoice.take : undefined;
  // A recording (or chosen take) is its own checkpoint: voicing runs keep it until it's replaced
  const input = recorded
    ? { recorded: recorded.path, durationMs: recorded.durationMs }
    : take
      ? { take: take.path, durationMs: take.durationMs }
      : hasParts
        ? { ...voiced.input, text: spokenText, parts: segments.filter((s) => s.part).map((s) => ({ text: s.text, narratorId: s.part!.narratorId })) }
        : voiced.input;

  let providerWords: WordTiming[] | undefined;
  const result = await runJobUnit({
    jobId,
    stage: 'tts',
    unitIndex,
    input,
    providerConfigId: configId,
    providerId,
    model,
    baseUrl: ctx.baseUrl,
    options: providerOptions,
    maxRetries,
    supabase,
    outputDir,
    signal,
    execute: async () => {
      if (recorded) {
        return { bytes: new Uint8Array(await readFile(recorded.path)), mimeType: 'audio/mpeg', durationMs: recorded.durationMs, usage: {} };
      }
      if (take) {
        providerWords = take.words;
        return { bytes: new Uint8Array(await readFile(take.path)), mimeType: take.path.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', durationMs: take.durationMs, usage: {}, words: take.words };
      }
      if (hasParts) {
        // The narrator's lines in this beat's voice, each quote in its character's voice
        const pieces: Array<{ bytes: Uint8Array; words?: WordTiming[] }> = [];
        for (const seg of segments) {
          const segSetup = seg.part ? await withNarrator(supabase, setup, seg.part.narratorId) : setup;
          const result = await synthesizeSpoken(segSetup, toSpeakableText(seg.text, setup.pronunciations), unitIndex);
          if (result.mimeType?.includes('wav')) throw new Error('Character voices need voices that return MP3');
          pieces.push({ bytes: result.bytes, words: result.words });
        }
        const joined = await joinSegments(pieces);
        providerWords = joined.words;
        return { bytes: joined.bytes, mimeType: 'audio/mpeg', usage: { characters: spokenText.length }, words: joined.words };
      }
      const synthesized = await synthesizeSpoken(setup, spokenText, unitIndex);
      providerWords = synthesized.words;
      return synthesized;
    },
  });

  if (result.success && result.outputPath) {
    try {
      await ensureWordTimings({
        audioPath: result.outputPath,
        text: narration,
        spokenText,
        durationMs: result.durationMs,
        providerWords,
      });
    } catch (err) {
      // Timings improve cuts and captions but must never fail voicing
      console.warn(`[voiceBeat] Could not save word timings for beat ${unitIndex}:`, err);
    }
  }
  return result;
}

/**
 * Writes word timings next to a beat's audio: aligned from provider timings when available,
 * otherwise estimated from the audio's pauses. Existing timings for the same text are kept.
 */
export async function ensureWordTimings(args: {
  audioPath: string;
  text: string;
  spokenText: string;
  durationMs?: number | null;
  providerWords?: WordTiming[];
}): Promise<void> {
  const { audioPath, text, spokenText, providerWords } = args;
  const durationMs = args.durationMs || (await getAudioDurationMs(audioPath));
  const durationSec = durationMs / 1000;

  if (!providerWords?.length) {
    const existing = await loadWordTimings(audioPath);
    if (existing && existing.text === text && existing.durationMs === durationMs) return;
  }

  const words = providerWords?.length
    ? alignWordTimings(text, providerWords, durationSec)
    : estimateWordTimings(text, durationSec, await detectSilences(audioPath, durationSec).catch(() => []));

  await saveWordTimings(audioPath, {
    version: 1,
    source: providerWords?.length ? 'provider' : 'estimated',
    text,
    spokenText,
    durationMs,
    words,
  });
}

/** Runs async tasks over items with at most `limit` in flight, preserving result order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
