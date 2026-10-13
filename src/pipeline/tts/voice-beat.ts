import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage, type ResolvedStageProvider } from '../providers/registry';
import type { TTSProvider } from '../providers/types';
import { runJobUnit, type UnitRunResult } from '../runner/unit-runner';
import { detectSilences, getAudioDurationMs } from '../utils/ffmpeg';
import { deliveryForStyle } from './delivery';
import { loadPronunciations } from './pronunciations';
import { toSpeakableText, type Pronunciation } from './speakable';
import {
  alignWordTimings,
  estimateWordTimings,
  loadWordTimings,
  saveWordTimings,
  type WordTiming,
} from './word-timings';

/** Everything needed to voice beats for one job: provider, voice, delivery and pronunciations. */
export interface TtsSetup {
  resolved: ResolvedStageProvider<TTSProvider>;
  voiceId: string;
  direction?: string;
  pronunciations: Pronunciation[];
}

interface JobVoiceFields {
  tts_provider_config_id?: string | null;
  voice_id?: string | null;
  voice_override?: string | null;
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
    direction: resolved.options.styleDirection === true ? deliveryForStyle(job.template) : undefined,
    pronunciations: await loadPronunciations(),
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
  return { spokenText, input };
}

export interface VoiceBeatOptions {
  supabase: SupabaseClient;
  setup: TtsSetup;
  jobId: string;
  unitIndex: number;
  narration: string;
  outputDir: string;
  signal?: AbortSignal;
}

/** Voices one beat through the checkpointed unit runner and saves its word timings. */
export async function voiceBeat(options: VoiceBeatOptions): Promise<UnitRunResult> {
  const { supabase, setup, jobId, unitIndex, narration, outputDir, signal } = options;
  const { provider, ctx, maxRetries, configId, providerId, model, options: providerOptions } = setup.resolved;
  const { spokenText, input } = ttsUnitInput(setup, narration);

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
      const synthesized = await provider.synthesize(
        { text: spokenText, voiceId: setup.voiceId, format: 'mp3', direction: setup.direction },
        ctx,
      );
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
