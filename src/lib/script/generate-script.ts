import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import { getRetryDecision } from '@/pipeline/providers/errors';
import type { LLMProvider, ProviderCallContext } from '@/pipeline/providers/types';
import { STYLE_TEMPLATES, VideoStyle } from './style-templates';
import { narrationPaceFactor } from '@/lib/styles/packs';
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
import type { BriefExtras, ScriptOutline } from './outline';
import type { FactCheckReport } from './fact-check-issues';
import type { PronunciationHints } from './pronunciation-hints-types';
import type { AdCheckReport } from './ad-check-issues';
import { leadWithPackageTitle, type PackageOption, type Packaging } from './packaging-types';
import type { RhythmReport } from './visual-rhythm';
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
  'timeline',
  'comparison',
  'title',
  'kinetic_text',
  'diagram',
] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

/** Diagram limits, shared by the shot planner and the renderer. */
export const DIAGRAM_LIMITS = {
  minSteps: 2,
  maxSteps: 5,
  /** Seconds of narration each step needs to be read. */
  secondsPerStep: 1.6,
  maxLabelWords: 5,
  maxDetailWords: 10,
} as const;

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
  timeline?: { events: Array<{ date: string; label: string }> };
  comparison?: { title?: string; left: { value: string; label: string }; right: { value: string; label: string } };
  /** Chapter card at a turn in the story. */
  title_card?: { text: string; kicker?: string };
  /** Words of the narration set as animated type, with a few emphasised. */
  kinetic?: { phrase: string; emphasis: string[] };
  /** "How it works": steps in order (process), in a loop (cycle), or parts of one thing (breakdown, around `center`). */
  diagram?: {
    kind: 'process' | 'cycle' | 'breakdown';
    title?: string;
    center?: string;
    steps: Array<{ label: string; detail?: string }>;
  };
  /** Lower-third name caption over footage (stock/archive) of a named person or place. */
  caption?: { name: string; detail?: string };
  /**
   * On a photo (stock/archive): circle one part of it and label it, Vox style. `target` tells
   * the vision model what to find ("the lock gates"); `label`/`detail` are shown.
   */
  annotation?: { target: string; label: string; detail?: string };
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
  /** Visual rhythm (slideshow risk) of the shot plan, and of the rendered visuals once made. */
  rhythm?: { plan?: RhythmReport; render?: RhythmReport };
  /** Brief mode: the creator's notes, the approved outline, and the brief's notes for publishing. */
  brief?: string;
  outline?: ScriptOutline;
  brief_extras?: BriefExtras;
  /** The independent fact-check run after the script was written. */
  fact_check?: FactCheckReport;
  /** Names the voice may mispronounce, with suggested respellings for the creator to confirm. */
  pronunciation_hints?: PronunciationHints;
  /** Wording likely to limit ads, with safer suggestions. */
  ad_check?: AdCheckReport;
  /** Title and thumbnail options decided before the script; the script delivers the chosen one. */
  packaging?: Packaging;
  /** 'short' for a native YouTube Short (a linked mini video); absent for normal videos. */
  format?: 'short';
  /** For a native Short: the long video it came from, and the on-screen hook banner. */
  short?: { parent_video_id: string; hook_banner: string };
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
  /** The creator's notes; the script follows their structure, tone and lines. */
  brief?: string | null;
  /** The outline the creator approved; the script follows it chapter by chapter. */
  outline?: ScriptOutline | null;
  /** The title and thumbnail promise the script must pay off. */
  packaging?: PackageOption | null;
  /** 'short': a native YouTube Short of about a minute, written for vertical viewing. */
  format?: 'short';
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

/** The outline as the script prompt shows it. */
export function formatOutlineForPrompt(outline: ScriptOutline): string {
  const chapters = outline.chapters
    .map((c, i) => {
      const facts = c.fact_ids?.length ? ` [facts: ${c.fact_ids.join(', ')}]` : '';
      return `${i + 1}. ${c.title}${facts}\n${c.points.map((p) => `   - ${p}`).join('\n')}`;
    })
    .join('\n');
  return `Hook: ${outline.hook}\n${chapters}\nClosing: ${outline.closing}`;
}

/** Rules for a native Short: it must work for someone with no context, in under a minute. */
export const SHORT_FORMAT_RULES = `THIS IS A YOUTUBE SHORT (vertical, under 60 seconds, watched by people who've never seen the channel):
- The first beat is the hook, said in the first 2 seconds: open mid-action or on the most surprising fact. No intro, no "in this video", no scene-setting first.
- One idea, one story beat, told fast: short sentences, no detours, no chapter structure.
- Every beat raises the stakes or answers part of the hook's question.
- End on a payoff line that lands hard and makes them want the full story. Never ask viewers to like, subscribe or check the description.`;

function briefSection(input: GenerateScriptInput): string {
  const parts: string[] = [];
  if (input.format === 'short') parts.push(SHORT_FORMAT_RULES);
  if (input.brief?.trim()) {
    parts.push(`CREATOR'S BRIEF (follow its structure, angle, tone and chapter order; use any opening or closing lines it gives, word for word; it overrides the style's defaults where they conflict, but never the research rules and never the word budget; ignore its title, thumbnail and source notes, which are used elsewhere):
"""
${input.brief.trim()}
"""`);
  }
  if (input.packaging) {
    parts.push(`PACKAGING (the title and thumbnail viewers clicked; the script must keep this promise):
Title: ${input.packaging.title}
Thumbnail: ${input.packaging.thumbnail_image}${input.packaging.thumbnail_text ? ` with the text "${input.packaging.thumbnail_text}"` : ''}
Promise: ${input.packaging.promise}
Open on this promise within the first few beats so the click feels rewarded, keep returning to its question, and answer it clearly and satisfyingly by the end. Put this title first in title_options.`);
  }
  if (input.outline?.chapters.length) {
    parts.push(`APPROVED OUTLINE (the creator signed this off: cover every chapter and point, in this order, with the hook first and the closing last; spread the word budget across the chapters):
${formatOutlineForPrompt(input.outline)}`);
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

export function buildUserPrompt(input: GenerateScriptInput): string {
  const budget = wordBudgetForMinutes(input.targetMinutes, narrationPaceFactor(input.style));
  return input.revisionOf
    ? `Revise this existing script for the topic "${input.topic}" (target ~${input.targetMinutes} minutes).
Requested changes: ${input.revisionOf.feedback}
${describeBudget(budget)} Keep to it unless the requested changes say otherwise.${briefSection(input)}${researchSection(input)}

Previous script JSON:
${JSON.stringify(scriptForPrompt(input.revisionOf.previousScript), null, 2)}`
    : `Write a script for the topic "${input.topic}". Target runtime: ~${input.targetMinutes} minutes.
${describeBudget(budget)}${briefSection(input)}${researchSection(input)}`;
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
Keep every rule from your instructions (hook, visual-type rules, accuracy). Return the complete revised script JSON.${briefSection(input)}${researchSection(input)}

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
  // Also keeps the packaged title first among the title options
  const withResearch = (draft: GeneratedScript): GeneratedScript => {
    const script = { ...draft, title_options: leadWithPackageTitle(draft.title_options ?? [], input.packaging) };
    return input.research
      ? { ...script, beats: applyResearchToBeats(script.beats, input.research), research: input.research }
      : script;
  };

  let best = await generateWithRetry(provider, ctx, maxRetries, template.systemPrompt, buildUserPrompt(input));
  if (input.revisionOf) {
    return withResearch(best);
  }

  const budget = wordBudgetForMinutes(input.targetMinutes, narrationPaceFactor(input.style));
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