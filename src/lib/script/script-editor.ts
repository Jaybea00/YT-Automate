import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import { getRetryDecision } from '@/pipeline/providers/errors';
import type { LLMProvider, ProviderCallContext } from '@/pipeline/providers/types';
import type { ResearchDossier } from '@/lib/research/types';
import { formatDossierForPrompt } from '@/lib/research/format';
import { RETENTION_CRAFT, VISUAL_TYPE_RULES, styleVoice, type VideoStyle } from './style-templates';
import { withWritingModel, type ScriptBeat } from './generate-script';
import {
  applyResearchToBeats,
  countScriptWords,
  estimateSpeechSeconds,
  normalizeBeats,
  scriptTextSignature,
} from './script-quality';

export interface EditorContext {
  beats: ScriptBeat[];
  topic: string;
  style: VideoStyle;
  research?: ResearchDossier | null;
  targetMinutes?: number;
}

const VISUAL_TYPE_ENUM = z.enum(['screen_recording', 'stock', 'chart', 'geo_map', 'archive', 'newspaper']);

const EditedBeatSchema = z.object({
  text: z.string(),
  visual_type: VISUAL_TYPE_ENUM,
  visual_query: z.string(),
  fact_ids: z.array(z.string()).nullable().optional(),
});

interface Editor {
  /** Structured call to the writing model, retrying transient failures (network drops, 503, 429). */
  generate<T>(req: { system: string; prompt: string; schema: z.ZodType<T> }): Promise<T>;
}

async function resolveEditor(supabase: SupabaseClient): Promise<Editor> {
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  const llm = resolved.provider;
  const ctx: ProviderCallContext = withWritingModel(resolved.ctx, resolved.options);
  // Interactive edits always get at least one retry: a dropped connection shouldn't surface as a failure
  const maxRetries = Math.max(1, resolved.maxRetries ?? 2);

  return {
    async generate<T>(req: { system: string; prompt: string; schema: z.ZodType<T> }): Promise<T> {
      for (let attempt = 1; ; attempt++) {
        try {
          const { data } = await llm.generateJson(req, ctx);
          return data;
        } catch (err) {
          const decision = getRetryDecision(err, attempt, maxRetries);
          if (!decision.retry) throw err;
          if (decision.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
        }
      }
    },
  };
}

function editorSystemPrompt(context: EditorContext): string {
  const research = context.research?.facts.length ? `\n\n${formatDossierForPrompt(context.research)}` : '';
  return `${styleVoice(context.style)}

${RETENTION_CRAFT}

${VISUAL_TYPE_RULES}${research}

You are editing an existing script, not writing a new one. Return JSON only.`;
}

const wordSet = (text: string) =>
  new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));

/** Share of distinct words two texts have in common (Jaccard), 0..1. */
export function wordOverlap(a: string, b: string): number {
  const wa = wordSet(a);
  const wb = wordSet(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/** Above this overlap, an alternative is a light touch-up of the original, not a real option. */
const NEAR_COPY_OVERLAP = 0.6;

function scriptListing(beats: ScriptBeat[]): string {
  return beats.map((b) => `[${b.index}] ${b.text}`).join('\n');
}

/** Turns an edited beat into a normal beat at `index`, with the same checks as generated scripts. */
function finalizeEditedBeat(
  index: number,
  edited: z.infer<typeof EditedBeatSchema>,
  research?: ResearchDossier | null,
): ScriptBeat {
  const [normalized] = normalizeBeats([
    { index, ...edited, fact_ids: edited.fact_ids ?? [], duration_estimate_seconds: 0 },
  ]);
  const beat = { ...normalized, index };
  return research ? applyResearchToBeats([beat], research)[0] : beat;
}

// --------------------------------------------------------------------------
// Beat rewrite
// --------------------------------------------------------------------------

const RewriteSchema = z.object({
  variants: z.array(EditedBeatSchema.extend({ angle: z.string() })),
});

export interface BeatVariant {
  angle: string;
  beat: ScriptBeat;
}

export function buildRewritePrompt(context: EditorContext, index: number, instruction: string): string {
  const beat = context.beats[index];
  return `Topic: "${context.topic}"

FULL SCRIPT (for context; beat numbers in brackets):
${scriptListing(context.beats)}

Rewrite beat [${index}] only:
"${beat.text}"

Instruction: ${instruction || 'Make it stronger for retention while keeping its role in the story.'}

Write 3 clearly different variants. Each must still flow from beat [${index - 1}] and lead into beat [${index + 1}], keep one idea, and stay 12-35 words unless the instruction asks for a different length. Use research facts for any specifics and list them in fact_ids. Choose visual_type and visual_query by the rules. Give each variant a 2-5 word "angle" naming what it changes.
Return {"variants": [{"angle", "text", "visual_type", "visual_query", "fact_ids"}]}.`;
}

export async function rewriteBeat(
  supabase: SupabaseClient,
  context: EditorContext,
  index: number,
  instruction: string,
): Promise<BeatVariant[]> {
  if (!context.beats[index]) throw new Error(`Beat ${index} does not exist`);
  const editor = await resolveEditor(supabase);
  const data = await editor.generate({
    system: editorSystemPrompt(context),
    prompt: buildRewritePrompt(context, index, instruction),
    schema: RewriteSchema,
  });
  // Identical variants (e.g. a visual-only instruction leaving the words unchanged) collapse into one
  const seen = new Set<string>();
  return data.variants
    .filter((v) => {
      const key = `${v.text.trim().toLowerCase()}|${v.visual_type}|${v.visual_query.trim().toLowerCase()}`;
      if (!v.text.trim() || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map((v) => ({ angle: v.angle.trim(), beat: finalizeEditedBeat(index, v, context.research) }));
}

// --------------------------------------------------------------------------
// Hook lab
// --------------------------------------------------------------------------

export const HOOK_TECHNIQUES = {
  cold_open: 'Cold open: drop the viewer into the most dramatic concrete moment, mid-action.',
  shock_stat: 'Shock stat: lead with the single most surprising researched number, made tangible.',
  question: 'Burning question: pose the question the whole video answers, so not knowing feels unbearable.',
  contrarian: 'Contrarian: challenge what most viewers believe about this topic, then promise the real story.',
} as const;
export type HookTechnique = keyof typeof HOOK_TECHNIQUES;

const HooksSchema = z.object({
  hooks: z.array(
    EditedBeatSchema.extend({
      technique: z.enum(Object.keys(HOOK_TECHNIQUES) as [HookTechnique, ...HookTechnique[]]),
      why_it_works: z.string(),
    }),
  ),
});

export interface HookOption {
  technique: HookTechnique;
  whyItWorks: string;
  beat: ScriptBeat;
}

export function buildHooksPrompt(context: EditorContext): string {
  return `Topic: "${context.topic}"

The video currently opens with beat [0]:
"${context.beats[0]?.text ?? ''}"

What follows:
${scriptListing(context.beats.slice(1, 4))}

Write 4 alternative versions of beat [0], one per technique:
${Object.entries(HOOK_TECHNIQUES).map(([key, desc]) => `- ${key}: ${desc}`).join('\n')}

Each hook must be a genuinely different opening from the current one: a new angle and new wording, not a touch-up. Each hook: 25 words or fewer, spoken in the first 8 seconds, no greeting or "in this video", must lead naturally into beat [1] as written, and must be true (specifics only from the research facts, listed in fact_ids). why_it_works: one sentence on the curiosity or stakes it creates.
Return {"hooks": [{"technique", "text", "why_it_works", "visual_type", "visual_query", "fact_ids"}]}.`;
}

export async function generateHooks(supabase: SupabaseClient, context: EditorContext): Promise<HookOption[]> {
  if (!context.beats.length) throw new Error('Script has no beats');
  const editor = await resolveEditor(supabase);
  const data = await editor.generate({
    system: editorSystemPrompt(context),
    prompt: buildHooksPrompt(context),
    schema: HooksSchema,
  });
  const seen = new Set<HookTechnique>();
  const currentHook = context.beats[0].text;
  return data.hooks
    .filter((h) => h.text.trim() && !seen.has(h.technique) && seen.add(h.technique))
    .filter((h) => wordOverlap(h.text, currentHook) < NEAR_COPY_OVERLAP)
    .map((h) => ({ technique: h.technique, whyItWorks: h.why_it_works.trim(), beat: finalizeEditedBeat(0, h, context.research) }));
}

// --------------------------------------------------------------------------
// Script doctor
// --------------------------------------------------------------------------

export const REVIEW_DIMENSIONS = ['hook', 'open_loops', 'rehooks', 'pacing', 'clarity', 'payoff'] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

const ReviewSchema = z.object({
  overall: z.number(),
  summary: z.string(),
  scores: z.array(z.object({ dimension: z.enum(REVIEW_DIMENSIONS), score: z.number(), note: z.string() })),
  issues: z.array(
    z.object({
      beat_index: z.number(),
      severity: z.enum(['high', 'medium', 'low']),
      problem: z.string(),
      fix_instruction: z.string(),
    }),
  ),
});

export interface ScriptMetrics {
  words: number;
  /** Narration plus the default pause between beats. */
  estimatedSeconds: number;
  targetSeconds?: number;
  beats: number;
  hookWords: number;
  longestBeatSeconds: number;
  /** Longest run of consecutive beats sharing a visual type. */
  longestSameVisualRun: number;
  unverifiedBeats: number;
}

export interface ScriptReview {
  overall: number;
  summary: string;
  /** Problems measured directly from the script, independent of the model's judgement. */
  warnings: string[];
  scores: Array<{ dimension: ReviewDimension; score: number; note: string }>;
  issues: Array<{ beatIndex: number; severity: 'high' | 'medium' | 'low'; problem: string; fixInstruction: string }>;
  metrics: ScriptMetrics;
  createdAt: string;
  /** Signature of the narration reviewed; differs once the script is edited. */
  basedOn: string;
}

const BEAT_PAUSE_SECONDS = 0.5;

export function computeScriptMetrics(beats: ScriptBeat[], targetMinutes?: number): ScriptMetrics {
  let longestRun = 0;
  let run = 0;
  beats.forEach((b, i) => {
    run = i > 0 && beats[i - 1].visual_type === b.visual_type ? run + 1 : 1;
    longestRun = Math.max(longestRun, run);
  });
  const speech = beats.reduce((s, b) => s + estimateSpeechSeconds(b.text), 0);
  return {
    words: countScriptWords(beats),
    estimatedSeconds: Math.round(speech + beats.length * BEAT_PAUSE_SECONDS),
    targetSeconds: targetMinutes ? Math.round(targetMinutes * 60) : undefined,
    beats: beats.length,
    hookWords: beats[0] ? beats[0].text.split(/\s+/).filter(Boolean).length : 0,
    longestBeatSeconds: Math.max(0, ...beats.map((b) => estimateSpeechSeconds(b.text))),
    longestSameVisualRun: longestRun,
    unverifiedBeats: beats.filter((b) => b.needs_check).length,
  };
}

export function buildReviewPrompt(context: EditorContext, metrics: ScriptMetrics): string {
  return `Topic: "${context.topic}"

You are a YouTube retention consultant reviewing this script before production. Be specific and demanding: a 7 is good, a 9 is rare.

MEASURED FACTS ABOUT THE SCRIPT:
- ${metrics.words} words, about ${metrics.estimatedSeconds}s spoken${metrics.targetSeconds ? ` (target ${metrics.targetSeconds}s)` : ''}, ${metrics.beats} beats
- Hook (beat 0) is ${metrics.hookWords} words; longest beat ~${metrics.longestBeatSeconds}s
- Longest run of the same visual type: ${metrics.longestSameVisualRun} beats
- Beats with numbers or quotes not backed by research: ${metrics.unverifiedBeats}

SCRIPT:
${context.beats.map((b) => `[${b.index}] (${b.visual_type}) ${b.text}`).join('\n')}

Score each dimension 1-10 with a one-sentence note: hook (first 8 seconds), open_loops (questions that keep viewers watching), rehooks (turns/reveals every ~45-60s), pacing (rhythm, no dragging or rushed beats), clarity (easy to follow by ear), payoff (ending resolves the opening). Give an overall score and a 2-sentence summary.
Then list up to 8 concrete issues with the NARRATION (wording, structure, pacing, clarity), most damaging first: the beat_index, the problem, and a fix_instruction a writer can apply to that beat's words (e.g. "Open with the 16.4 million shares figure instead of the date"). Don't report visual choices; a separate director plans the visuals. Never suggest removing an attribution or hedge ("by one estimate", "historians argue") that keeps a claim accurate, and never suggest stating a figure more precisely than its source.
Return {"overall", "summary", "scores": [...], "issues": [...]}.`;
}

export async function reviewScript(supabase: SupabaseClient, context: EditorContext): Promise<ScriptReview> {
  if (!context.beats.length) throw new Error('Script has no beats');
  const metrics = computeScriptMetrics(context.beats, context.targetMinutes);
  const editor = await resolveEditor(supabase);
  const data = await editor.generate({
    system: editorSystemPrompt(context),
    prompt: buildReviewPrompt(context, metrics),
    schema: ReviewSchema,
  });
  return finalizeReview(data, context.beats, metrics);
}

const clampScore = (n: number) => Math.min(10, Math.max(1, Math.round(n)));
const formatSeconds = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Deterministic warnings: things the numbers prove, which a lenient model review can gloss over. */
export function metricWarnings(metrics: ScriptMetrics): string[] {
  const warnings: string[] = [];
  if (metrics.targetSeconds) {
    const ratio = metrics.estimatedSeconds / metrics.targetSeconds;
    if (ratio < 0.9 || ratio > 1.1) {
      warnings.push(
        `Runtime is about ${formatSeconds(metrics.estimatedSeconds)} against a ${formatSeconds(metrics.targetSeconds)} target (${Math.round(ratio * 100)}%). ${ratio < 1 ? 'Add substance or beats' : 'Trim'} to reach it.`,
      );
    }
  }
  if (metrics.hookWords > 25) {
    warnings.push(`The hook is ${metrics.hookWords} words; keep the first beat to about 20 so it lands in the first 8 seconds.`);
  }
  if (metrics.longestBeatSeconds > 15) {
    warnings.push(`The longest beat runs about ${Math.round(metrics.longestBeatSeconds)}s; consider splitting beats over 15s.`);
  }
  if (metrics.longestSameVisualRun > 3) {
    warnings.push(`${metrics.longestSameVisualRun} beats in a row share one visual type; vary them to keep the picture fresh.`);
  }
  if (metrics.unverifiedBeats > 0) {
    warnings.push(`${metrics.unverifiedBeats} beat${metrics.unverifiedBeats === 1 ? ' states' : 's state'} numbers or quotes no research fact supports.`);
  }
  return warnings;
}
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function finalizeReview(
  raw: z.infer<typeof ReviewSchema>,
  beats: ScriptBeat[],
  metrics: ScriptMetrics,
): ScriptReview {
  const seen = new Set<ReviewDimension>();
  return {
    overall: clampScore(raw.overall),
    summary: raw.summary.trim(),
    warnings: metricWarnings(metrics),
    scores: raw.scores
      .filter((s) => !seen.has(s.dimension) && seen.add(s.dimension))
      .map((s) => ({ dimension: s.dimension, score: clampScore(s.score), note: s.note.trim() })),
    issues: raw.issues
      .filter((i) => Number.isInteger(i.beat_index) && i.beat_index >= 0 && i.beat_index < beats.length)
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      .slice(0, 8)
      .map((i) => ({
        beatIndex: i.beat_index,
        severity: i.severity,
        problem: i.problem.trim(),
        fixInstruction: i.fix_instruction.trim(),
      })),
    metrics,
    createdAt: new Date().toISOString(),
    basedOn: scriptTextSignature(beats),
  };
}
