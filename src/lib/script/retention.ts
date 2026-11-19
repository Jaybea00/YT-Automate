import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider } from '@/pipeline/providers/types';
import type { StylePack } from '@/lib/styles/packs';
import { checkerContext } from './fact-check';
import type { ScriptBeat } from './generate-script';
import type { PackageOption } from './packaging-types';
import {
  beatTimeline,
  finalizeIssues,
  measuredIssues,
  paceLimits,
  retentionScore,
  type BeatMarks,
  type OpenLoop,
  type PromiseCheck,
  type RetentionReport,
} from './retention-types';

export * from './retention-types';

/**
 * Retention check: will viewers keep watching? The model marks what each beat does (how gripping
 * it is, whether it adds something, where sections start, which questions open and close, and
 * whether the title's promise is paid off); measured rules turn that into the problems that make
 * people leave, each with a rewrite of the beat to fix it.
 */

const RetentionSchema = z.object({
  promise: z.object({
    promise: z.string().describe('What the title and hook promise the viewer, in one sentence'),
    status: z.enum(['paid', 'partial', 'unpaid']),
    paid_at: z.number().nullable().describe('Beat index where the promise is delivered, or null'),
    note: z.string().describe('One short sentence on how well it is delivered; do not mention beat numbers'),
  }),
  beats: z.array(
    z.object({
      index: z.number(),
      interest: z.number().describe('1 = skippable, 3 = fine, 5 = cannot look away'),
      new_info: z.boolean(),
      stakes: z.boolean(),
      pattern_break: z.boolean(),
      section_start: z.string().nullable().describe('Short section name when a new section starts at this beat, else null'),
      rehook: z.boolean().describe('At a section start: does it give a fresh reason to keep watching?'),
    }),
  ),
  loops: z.array(
    z.object({
      question: z.string(),
      opened_at: z.number(),
      closed_at: z.number().nullable(),
    }),
  ),
  rewrites: z
    .array(z.object({ index: z.number(), text: z.string().describe('The whole beat rewritten, keeping every fact, number, name and quote of the original') }))
    .describe('Rewrites for the weakest beats only (at most 10)'),
});

export function buildRetentionPrompt(input: {
  beats: ScriptBeat[];
  starts: number[];
  totalSeconds: number;
  title?: string;
  promise?: string;
  styleLabel?: string;
}): string {
  const { beats, starts, totalSeconds } = input;
  const { breakEvery, loopGap } = paceLimits(totalSeconds);
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return `Judge this YouTube narration for audience retention: would a viewer keep watching, second by second?
${input.styleLabel ? `It is a ${input.styleLabel} video. ` : ''}It runs about ${clock(totalSeconds)}.
TITLE: ${input.title || '(none)'}
${input.promise ? `THE PROMISE THE VIDEO WAS PLANNED TO DELIVER: ${input.promise}\n` : ''}
For EVERY beat, mark:
- interest: 1-5. Be honest and strict: 5 only for beats that are truly gripping; 2 or less for filler, repetition, throat-clearing, or explanation nobody asked for.
- new_info: it adds a fact or detail the viewer didn't have.
- stakes: it makes the viewer care what happens (risk, consequence, conflict, a mystery deepening).
- pattern_break: a change of pace (a surprise, a direct question to the viewer, a contrast, a turn in the story, the start of a new section). Viewers need one about every ${breakEvery}s.
- section_start: when this beat starts a new section or chapter, its short name; else null. Beat 0 is the hook, not a section.
- rehook: at a section start, whether it opens with a fresh reason to keep watching.

loops: the questions the narration makes the viewer want answered ("why did it crash?", "what was in the box?"), with the beat that raises each and the beat that answers it (null if never). Viewers should always have one waiting; a gap of more than ${loopGap}s with none loses them.

promise: what the title and hook promise, whether the video delivers it (paid, partial, unpaid) and at which beat.

rewrites: for the weakest beats only (at most 10), the whole beat rewritten to fix its retention problem: raise the stakes, raise a question, re-hook a section, or change the pace. Every fact, number, name and quote in the original beat must still be in the rewrite (rephrase, reorder or add tension around them, but never drop one); never invent facts; keep about the same length.

In "note" and anywhere else in your answer, refer to moments by what happens, never by beat number.

NARRATION (beat index, start time, text):
${beats.map((b, i) => `[${b.index}] ${clock(starts[i])} ${b.text}`).join('\n')}`;
}

/** Keeps the model's marks to real beats and sane values; beats it skipped get neutral marks. */
export function normalizeMarks(raw: z.infer<typeof RetentionSchema>['beats'], beats: ScriptBeat[]): BeatMarks[] {
  return beats.map((b) => {
    const r = raw.find((x) => x.index === b.index);
    return {
      beat_index: b.index,
      interest: r ? Math.max(1, Math.min(5, Math.round(r.interest))) : 3,
      new_info: r?.new_info ?? true,
      stakes: r?.stakes ?? false,
      pattern_break: r?.pattern_break ?? false,
      section_start: r?.section_start?.trim() || null,
      rehook: r?.rehook ?? true,
    };
  });
}

export function normalizeLoops(raw: z.infer<typeof RetentionSchema>['loops'], beatCount: number): OpenLoop[] {
  const valid = (i: number | null) => i != null && Number.isInteger(i) && i >= 0 && i < beatCount;
  return raw
    .filter((l) => l.question.trim() && valid(l.opened_at))
    .map((l) => ({ question: l.question.trim(), opened_at: l.opened_at, closed_at: valid(l.closed_at) && l.closed_at! >= l.opened_at ? l.closed_at : null }));
}

export async function retentionCheckScript(
  supabase: SupabaseClient,
  beats: ScriptBeat[],
  opts: { title?: string; packaging?: PackageOption | null; pack?: StylePack } = {},
): Promise<RetentionReport> {
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  const ctx = checkerContext(resolved.ctx, resolved.options);
  const { starts, totalSeconds } = beatTimeline(beats);
  const { data } = await resolved.provider.generateJson(
    {
      system: 'You are a YouTube retention editor. You know why viewers click away and how to keep them watching, and you are honest about weak beats.',
      prompt: buildRetentionPrompt({ beats, starts, totalSeconds, title: opts.packaging?.title || opts.title, promise: opts.packaging?.promise, styleLabel: opts.pack?.label }),
      schema: RetentionSchema,
      maxTokens: 16000,
    },
    ctx,
  );
  const marks = normalizeMarks(data.beats, beats);
  const loops = normalizeLoops(data.loops, beats.length);
  const paidAt = data.promise.paid_at;
  const promise: PromiseCheck = {
    promise: data.promise.promise.trim() || opts.packaging?.promise || opts.title || '',
    status: data.promise.status,
    paid_at: paidAt != null && Number.isInteger(paidAt) && paidAt >= 0 && paidAt < beats.length ? paidAt : null,
    note: data.promise.note.trim(),
  };
  const suggestions = new Map(data.rewrites.filter((r) => r.text.trim()).map((r) => [r.index, r.text.trim()]));
  const issues = finalizeIssues(measuredIssues({ starts, totalSeconds, marks, loops, promise: promise.promise ? promise : null }), suggestions, beats);
  return {
    checkedAt: new Date().toISOString(),
    ...(ctx.model ? { model: ctx.model } : {}),
    beatsChecked: beats.length,
    starts,
    totalSeconds,
    score: retentionScore(marks, issues),
    marks,
    loops,
    promise: promise.promise ? promise : null,
    issues,
  };
}

/** The automatic check after a script is written: never fails the write. */
export async function retentionCheckOrNull(
  supabase: SupabaseClient,
  beats: ScriptBeat[],
  opts: { title?: string; packaging?: PackageOption | null; pack?: StylePack } = {},
): Promise<RetentionReport | null> {
  try {
    const report = await retentionCheckScript(supabase, beats, opts);
    console.log(`[retention] score ${report.score}, ${report.issues.length} issue(s)`);
    return report;
  } catch (err) {
    console.warn('[retention] Retention check failed:', err instanceof Error ? err.message.slice(0, 200) : err);
    return null;
  }
}
