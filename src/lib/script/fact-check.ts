import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider, ProviderCallContext } from '@/pipeline/providers/types';
import type { ResearchDossier } from '@/lib/research/types';
import type { ScriptBeat } from './generate-script';
import { FACT_CHECK_KINDS, type FactCheckIssue, type FactCheckKind, type FactCheckReport } from './fact-check-issues';

/**
 * An independent fact-check of a written script: a second pass, by a different model from the
 * writer where one is configured, re-reads every beat against the research it cites. It also
 * flags claims about living people that could harm their reputation, even when sourced, so the
 * creator looks twice before publishing.
 */

export {
  FACT_CHECK_KINDS,
  FACT_CHECK_LABEL,
  openIssues,
  type FactCheckIssue,
  type FactCheckKind,
  type FactCheckReport,
} from './fact-check-issues';

const IssuesSchema = z.object({
  issues: z.array(
    z.object({
      beat_index: z.number(),
      kind: z.string(),
      claim: z.string(),
      problem: z.string(),
      suggested_text: z.string().optional(),
      person: z.string().optional(),
    }),
  ),
});

/** Beats per call: keeps each answer short enough to be complete. */
const BEATS_PER_CALL = 60;

/**
 * The checker's model: the binding option `factCheckModel` when set, otherwise the binding's
 * base model, which differs from the writer when `writingModel` is configured.
 */
export function checkerContext(ctx: ProviderCallContext, options: Record<string, unknown>): ProviderCallContext {
  const model = options.factCheckModel;
  return typeof model === 'string' && model.trim() ? { ...ctx, model: model.trim() } : ctx;
}

export function buildFactCheckPrompt(beats: ScriptBeat[], research: ResearchDossier | null | undefined): string {
  const beatLines = beats
    .map((b) => `[${b.index}]${b.fact_ids?.length ? ` (cites ${b.fact_ids.join(', ')})` : ''} ${b.text}`)
    .join('\n');
  const sources = research?.facts.length
    ? `RESEARCHED FACTS (with their sources):
${research.facts
  .map((f) => {
    const titles = f.sourceIds.map((id) => research.sources.find((s) => s.id === id)?.title ?? id).join('; ');
    return `${f.id}: ${f.claim} [${titles}]`;
  })
  .join('\n')}`
    : 'There is no research for this script: judge "contradicts" and "distorted" from well-established knowledge only, when you are confident, and skip "unsupported".';

  return `Fact-check this documentary narration, beat by beat.

${sources}

NARRATION (beat index, the facts it cites, its text):
${beatLines}

Report only problems, as issues:
- "contradicts": the beat states something the facts contradict.
- "distorted": the beat uses a fact but changes a detail: a number, date, place, who did or said it, or its scope (a figure for one day presented as a week, a claim about some presented as all).
- "unsupported": the beat states a specific (a number, date, quote, or a named person doing something) that no fact above supports, whether or not the beat cites one.
- "living_person": a claim about a person who is alive today, as far as you know, involving crime, accusations, violence, health, sexuality, money troubles, family or private life, or anything else that could harm their reputation. Flag these even when a fact supports them, and set "person".
Don't flag storytelling, opinion clearly framed as opinion, scene-setting, or common knowledge. One issue per problem; a beat can have several.
For each issue: "claim" quotes the words in the beat; "problem" says in one sentence what's wrong and what the source says; "suggested_text" is the whole beat rewritten to fix it, keeping its length and voice (for living_person: fairer wording that attributes the claim, e.g. "according to...", "was accused of", or drops what the sources can't back).
Return {"issues": []} when nothing is wrong.`;
}

/** Keeps issues the model reported for real beats, without duplicates or no-op suggestions. */
export function normalizeIssues(raw: z.infer<typeof IssuesSchema>['issues'], beats: ScriptBeat[]): FactCheckIssue[] {
  const byIndex = new Map(beats.map((b) => [b.index, b]));
  const seen = new Set<string>();
  const issues: FactCheckIssue[] = [];
  for (const r of raw) {
    const beat = byIndex.get(r.beat_index);
    const kind = r.kind.trim().toLowerCase().replace(/[\s-]+/g, '_') as FactCheckKind;
    if (!beat || !FACT_CHECK_KINDS.includes(kind) || !r.problem.trim()) continue;
    const claim = r.claim.trim();
    const key = `${beat.index}|${kind}|${claim.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const suggestion = r.suggested_text?.trim();
    const count = issues.filter((i) => i.beat_index === beat.index).length;
    issues.push({
      id: `fc-${beat.index}-${count + 1}`,
      beat_index: beat.index,
      kind,
      claim,
      problem: r.problem.trim(),
      ...(suggestion && suggestion !== beat.text.trim() ? { suggested_text: suggestion } : {}),
      ...(kind === 'living_person' && r.person?.trim() ? { person: r.person.trim() } : {}),
      checked_text: beat.text,
    });
  }
  return issues;
}

export async function factCheckScript(
  supabase: SupabaseClient,
  beats: ScriptBeat[],
  research: ResearchDossier | null | undefined,
): Promise<FactCheckReport> {
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  const ctx = checkerContext(resolved.ctx, resolved.options);
  const issues: FactCheckIssue[] = [];
  for (let start = 0; start < beats.length; start += BEATS_PER_CALL) {
    const chunk = beats.slice(start, start + BEATS_PER_CALL);
    const { data } = await resolved.provider.generateJson(
      {
        system:
          'You are a meticulous documentary fact-checker and standards editor. You compare narration with its sources precisely, and you protect real people from unfair claims.',
        prompt: buildFactCheckPrompt(chunk, research),
        schema: IssuesSchema,
      },
      ctx,
    );
    issues.push(...normalizeIssues(data.issues, chunk));
  }
  return {
    checkedAt: new Date().toISOString(),
    ...(ctx.model ? { model: ctx.model } : {}),
    beatsChecked: beats.length,
    hadResearch: Boolean(research?.facts.length),
    issues,
  };
}

/** The automatic check after a script is written: never fails the write. */
export async function factCheckOrNull(
  supabase: SupabaseClient,
  beats: ScriptBeat[],
  research: ResearchDossier | null | undefined,
): Promise<FactCheckReport | null> {
  try {
    const report = await factCheckScript(supabase, beats, research);
    console.log(`[factCheck] ${report.issues.length} issue(s) in ${report.beatsChecked} beats (${report.model ?? 'default model'})`);
    return report;
  } catch (err) {
    console.warn('[factCheck] Fact-check failed; the script is saved without it:', err instanceof Error ? err.message.slice(0, 200) : err);
    return null;
  }
}
