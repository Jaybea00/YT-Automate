import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import { getRetryDecision } from '@/pipeline/providers/errors';
import type { LLMProvider, ProviderCallContext } from '@/pipeline/providers/types';
import { STYLE_TEMPLATES, VideoStyle } from './style-templates';
import {
  TARGET_WORDS_PER_BEAT,
  applyResearchToBeats,
  countScriptWords,
  normalizeBeats,
  wordBudgetForMinutes,
  type WordBudget,
} from './script-quality';
import type { ResearchDossier } from '@/lib/research/types';
import type { ScriptReview } from './script-editor';
import { formatDossierForPrompt } from '@/lib/research/format';

export const SHOT_TYPES = [
  'stock',
  'archive',
  'chart',
  'stat',
  'quote',
  'geo_map',
  'newspaper',
  'screen_recording',
] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

/**
 * One visual within a beat. Shots split the beat's narration into consecutive word ranges
 * (word_start/word_count index into beat.text split on whitespace), so assembly can cut on
 * the exact words each visual plays under.
 */
export interface ShotPlan {
  visual_type: ShotType;
  /** Search phrase (stock/archive), URL (screen_recording), or one-line summary of the spec. */
  visual_query: string;
  /** The narration this shot plays under. */
  covers: string;
  word_start: number;
  word_count: number;
  fact_ids?: string[];
  chart?: { chart_type: 'line' | 'bar' | 'pie'; title: string; unit?: string; labels: string[]; values: number[] };
  stat?: { value: number; prefix?: string; suffix?: string; label: string };
  quote?: { text: string; attribution: string };
  map?: { places: string[]; mode: 'route' | 'spread' | 'locate' };
  newspaper?: { outlet: string; date: string; headline: string };
}

export interface ScriptBeat {
  index: number;
  text: string;
  visual_type: 'screen_recording' | 'stock' | 'chart' | 'geo_map' | 'archive' | 'newspaper';
  visual_query: string;
  duration_estimate_seconds: number;
  /** Research facts (ids in GeneratedScript.research) this beat's specifics come from. */
  fact_ids?: string[];
  /** States numbers or quotes that no research fact backs; shown for review before approval. */
  needs_check?: boolean;
  /** Director's shot plan. Absent on scripts planned before shots existed; visual_type/visual_query remain the fallback. */
  shots?: ShotPlan[];
}

export interface GeneratedScript {
  title_options: string[];
  beats: ScriptBeat[];
  /** Fact dossier the script was written from, when research succeeded. */
  research?: ResearchDossier;
  /** Latest script-doctor review, saved from the review page. */
  review?: ScriptReview;
}

export const ScriptBeatSchema = z.object({
  index: z.number(),
  text: z.string(),
  visual_type: z.enum(['screen_recording', 'stock', 'chart', 'geo_map', 'archive', 'newspaper']),
  visual_query: z.string(),
  duration_estimate_seconds: z.number(),
  fact_ids: z.array(z.string()).optional(),
});

export const GeneratedScriptSchema = z.object({
  title_options: z.array(z.string()),
  beats: z.array(ScriptBeatSchema),
});

export interface GenerateScriptInput {
  topic: string;
  style: VideoStyle;
  targetMinutes: number;
  /** Set when revising — the prior script plus the user's requested changes. */
  revisionOf?: { previousScript: GeneratedScript; feedback: string };
  /** Researched facts to write from; every specific in the narration must come from here. */
  research?: ResearchDossier | null;
}

export interface GenerateScriptOptions {
  /** Extra LLM passes allowed to bring a fresh script inside its word budget (default 2). */
  maxLengthPasses?: number;
}

/**
 * Full-script writing can use a stronger (slower) model than the script binding's default,
 * via the binding option `writingModel`. Short helper calls (keyword extraction, chart data,
 * visual hints) keep using the binding's fast model.
 */
export function withWritingModel(
  ctx: ProviderCallContext,
  options: Record<string, unknown>,
): ProviderCallContext {
  const writingModel = options.writingModel;
  return typeof writingModel === 'string' && writingModel.trim()
    ? { ...ctx, model: writingModel.trim() }
    : ctx;
}

function describeBudget(budget: WordBudget): string {
  return `Word budget for the narration: ${budget.min}-${budget.max} words in total (aim for ${budget.target}). Write about ${budget.targetBeats} beats averaging ${TARGET_WORDS_PER_BEAT} words each (18-30 words per beat).`;
}

/**
 * Only the parts of a stored script the model should see: no render settings (bgm/sfx),
 * no dossier (sent separately), no review flags.
 */
function scriptForPrompt(script: GeneratedScript): GeneratedScript {
  return {
    title_options: script.title_options,
    // undefined fields are dropped when the script is serialized into the prompt
    beats: script.beats.map((beat) => ({ ...beat, needs_check: undefined })),
  };
}

function researchSection(input: GenerateScriptInput): string {
  return input.research?.facts.length ? `\n\n${formatDossierForPrompt(input.research)}` : '';
}

export function buildUserPrompt(input: GenerateScriptInput): string {
  const budget = wordBudgetForMinutes(input.targetMinutes);
  return input.revisionOf
    ? `Revise this existing script for the topic "${input.topic}" (target ~${input.targetMinutes} minutes).
Requested changes: ${input.revisionOf.feedback}
${describeBudget(budget)} Keep to it unless the requested changes say otherwise.${researchSection(input)}

Previous script JSON:
${JSON.stringify(scriptForPrompt(input.revisionOf.previousScript), null, 2)}`
    : `Write a script for the topic "${input.topic}". Target runtime: ~${input.targetMinutes} minutes.
${describeBudget(budget)}${researchSection(input)}`;
}

export function buildLengthFixPrompt(
  input: GenerateScriptInput,
  script: GeneratedScript,
  budget: WordBudget,
): string {
  const words = countScriptWords(script.beats);
  const averagePerBeat = Math.round(words / Math.max(1, script.beats.length));
  const direction =
    words < budget.min
      ? // Models reliably add less than asked when expanding, so request a little extra
        `It is ${budget.target - words} words too short (beats average ${averagePerBeat} words; they should average ${TARGET_WORDS_PER_BEAT}). Add about ${Math.round((budget.target - words) * 1.2)} words: deepen existing beats with specific details, examples, and consequences, or add beats where the story has gaps. No filler, no repetition.`
      : `It is ${words - budget.target} words too long. Condense it: tighten wording, merge overlapping beats, and cut the weakest material. Keep the hook, the key facts, and the ending.`;

  return `The script below for "${input.topic}" has ${words} words of narration. ${describeBudget(budget)}
${direction}
Keep every rule from your instructions (hook, visual-type rules, accuracy). Return the complete revised script JSON.${researchSection(input)}

Current script JSON:
${JSON.stringify(scriptForPrompt(script), null, 2)}`;
}

async function generateWithRetry(
  provider: LLMProvider,
  ctx: ProviderCallContext,
  maxRetries: number,
  system: string,
  prompt: string,
): Promise<GeneratedScript> {
  let currentAttempt = 1;
  let lastError: unknown;

  while (currentAttempt <= maxRetries + 1) {
    try {
      const response = await provider.generateJson<GeneratedScript>(
        { system, prompt, schema: GeneratedScriptSchema },
        ctx,
      );

      const beats = normalizeBeats(response.data.beats ?? []);
      if (beats.length === 0) {
        throw new Error('Script generation returned no beats.');
      }
      return { title_options: response.data.title_options, beats };
    } catch (err) {
      lastError = err;
      const decision = getRetryDecision(err, currentAttempt, maxRetries);

      if (decision.retry && currentAttempt <= maxRetries) {
        currentAttempt++;
        if (decision.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
        }
        continue;
      }
      break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Runs script generation for a video.
 * Resolves the configured provider for the 'script' stage via the pipeline registry,
 * applies Zod schema validation, and wraps execution in the registry's retry policy
 * (covering 429 rate limits and 503 transient errors).
 *
 * Fresh scripts that miss their word budget get up to `maxLengthPasses` correction passes;
 * the version closest to the target is returned. Revisions are not length-corrected, so
 * feedback like "make it shorter" is respected.
 */
export async function generateScript(
  supabase: SupabaseClient,
  input: GenerateScriptInput,
  options: GenerateScriptOptions = {},
): Promise<GeneratedScript> {
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  const { provider, maxRetries = 2 } = resolved;
  const ctx = withWritingModel(resolved.ctx, resolved.options);
  const template = STYLE_TEMPLATES[input.style];
  if (!template) {
    throw new Error(`Unknown video style: "${input.style}". Valid styles: ${Object.keys(STYLE_TEMPLATES).join(', ')}`);
  }

  // Links beats to the dossier, flags unsupported specifics, and stores the dossier with the script
  const withResearch = (script: GeneratedScript): GeneratedScript =>
    input.research
      ? { ...script, beats: applyResearchToBeats(script.beats, input.research), research: input.research }
      : script;

  let best = await generateWithRetry(provider, ctx, maxRetries, template.systemPrompt, buildUserPrompt(input));
  if (input.revisionOf) {
    return withResearch(best);
  }

  const budget = wordBudgetForMinutes(input.targetMinutes);
  const distance = (s: GeneratedScript) => Math.abs(countScriptWords(s.beats) - budget.target);
  const inBudget = (s: GeneratedScript) => {
    const words = countScriptWords(s.beats);
    return words >= budget.min && words <= budget.max;
  };

  console.log(
    `[generateScript] Draft: ${countScriptWords(best.beats)} words, ${best.beats.length} beats (budget ${budget.min}-${budget.max})`,
  );

  const maxLengthPasses = options.maxLengthPasses ?? 2;
  for (let pass = 0; pass < maxLengthPasses && !inBudget(best); pass++) {
    try {
      const candidate = await generateWithRetry(
        provider,
        ctx,
        maxRetries,
        template.systemPrompt,
        buildLengthFixPrompt(input, best, budget),
      );
      console.log(
        `[generateScript] Length pass ${pass + 1}: ${countScriptWords(candidate.beats)} words, ${candidate.beats.length} beats`,
      );
      if (distance(candidate) < distance(best)) {
        best = candidate;
      }
    } catch (err) {
      // A failed correction pass shouldn't discard a usable script
      console.warn('[generateScript] Length correction pass failed; keeping previous version:', err);
      break;
    }
  }

  return withResearch(best);
}