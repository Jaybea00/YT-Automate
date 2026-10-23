import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider } from '@/pipeline/providers/types';
import type { ResearchDossier, ResearchFact } from '@/lib/research/types';
import { STYLE_TEMPLATES, type VideoStyle } from './style-templates';
import { withWritingModel } from './generate-script';

/**
 * Brief mode: the creator pastes notes (chapters, angle, facts, lines they want, title and
 * thumbnail ideas, sources). An outline is drafted from the brief and the research, the creator
 * approves or edits it, and only then is the full script written.
 */

/** Long briefs are fine, but a runaway paste shouldn't blow the prompt. */
export const MAX_BRIEF_CHARS = 20_000;
/** Source id for facts the creator gave in the brief. */
export const BRIEF_SOURCE_ID = 'brief';

export interface OutlineChapter {
  title: string;
  /** What happens in this chapter, in story order. */
  points: string[];
  /** Research facts this chapter should use. */
  fact_ids?: string[];
}

export interface ScriptOutline {
  /** The cold open: the moment, the stakes and the question that keeps people watching. */
  hook: string;
  chapters: OutlineChapter[];
  /** How the video ends: the payoff and the last line. */
  closing: string;
}

/** The parts of a brief meant for later stages rather than the narration. */
export interface BriefExtras {
  title_ideas: string[];
  thumbnail_ideas: string[];
  /** Sources the creator listed, as written (title, outlet, URL). */
  sources: string[];
}

const OutlineSchema = z.object({
  hook: z.string(),
  chapters: z.array(
    z.object({
      title: z.string(),
      points: z.array(z.string()),
      fact_ids: z.array(z.string()).optional(),
    }),
  ),
  closing: z.string(),
  brief_facts: z.array(z.string()).optional(),
  title_ideas: z.array(z.string()).optional(),
  thumbnail_ideas: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
});

export function trimBrief(brief: string | null | undefined): string {
  return (brief ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_BRIEF_CHARS);
}

const cleanList = (items: string[] | undefined, max: number) =>
  [...new Set((items ?? []).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, max);

/** Tidies an outline from the model or from the editor: no empty chapters or points, known fact ids only. */
export function normalizeOutline(raw: ScriptOutline, factIds?: Set<string>): ScriptOutline {
  const chapters = raw.chapters
    .map((c) => {
      const ids = cleanList(c.fact_ids, 20).filter((id) => !factIds || factIds.has(id));
      return {
        title: c.title.replace(/\s+/g, ' ').trim(),
        points: cleanList(c.points, 12),
        ...(ids.length ? { fact_ids: ids } : {}),
      };
    })
    .filter((c) => c.title || c.points.length)
    .slice(0, 20);
  return { hook: raw.hook.trim(), chapters, closing: raw.closing.trim() };
}

/**
 * Adds the specifics the creator gave in the brief to the research, so the script can cite
 * them like any researched fact (and they aren't flagged as unsourced).
 */
export function mergeBriefFacts(
  research: ResearchDossier | null,
  topic: string,
  briefFacts: string[],
): ResearchDossier | null {
  const claims = cleanList(briefFacts, 40);
  if (claims.length === 0) return research;
  const facts: ResearchFact[] = claims.map((claim, i) => ({ id: `B${i + 1}`, claim, sourceIds: [BRIEF_SOURCE_ID] }));
  const source = { id: BRIEF_SOURCE_ID, title: "Creator's brief", url: '' };
  if (!research) {
    return { topic, provider: 'brief', createdAt: new Date().toISOString(), sources: [source], facts };
  }
  return { ...research, sources: [...research.sources, source], facts: [...research.facts, ...facts] };
}

/** A chapter for every minute or so, within reason. */
export const chapterCount = (minutes: number) => Math.min(12, Math.max(3, Math.round(minutes * 0.8)));

export function buildOutlinePrompt(input: {
  topic: string;
  style: VideoStyle;
  targetMinutes: number;
  brief: string;
  research?: ResearchDossier | null;
}): string {
  const style = STYLE_TEMPLATES[input.style];
  const facts = input.research?.facts.length
    ? `\n\nRESEARCHED FACTS (cite by id):\n${input.research.facts.map((f) => `${f.id}: ${f.claim}`).join('\n')}`
    : '';
  return `Plan a YouTube video before its script is written.
Topic: "${input.topic}"
Style: ${style?.label ?? input.style}${style?.description ? ` (${style.description})` : ''}
Target runtime: ~${input.targetMinutes} minutes

CREATOR'S BRIEF:
"""
${input.brief}
"""${facts}

Write the outline:
- hook: the cold open in 1-3 sentences: the most gripping moment, what's at stake, and the question the video answers. If the brief gives an opening, use it.
- chapters: follow the brief's structure, order and chapter names when it has them; otherwise design about ${chapterCount(input.targetMinutes)} chapters that build to the payoff. Each chapter gets 2-6 points: concrete story beats in order (who, what, where, the turn), not vague themes. Set fact_ids to the researched facts each chapter should use.
- closing: the payoff and the final line. If the brief gives closing lines, use them.
- brief_facts: every specific the brief itself states (numbers, dates, names with what they did, quotes with who said them, headlines with outlet), one self-contained sentence each, exactly as the brief has them. [] if none.
- title_ideas: titles the creator suggests in the brief, as written. [] if none.
- thumbnail_ideas: thumbnail wishes in the brief (image, text, look), as written. [] if none.
- sources: sources the brief lists (articles, books, links), as written. [] if none.
Never invent specifics: points may only state numbers, dates, quotes or headlines that are in the brief or the researched facts. Where the brief and research disagree, follow the research and keep the point general. Return JSON.`;
}

/** Drafts the outline for a brief. Throws when the model fails; the caller decides what to do. */
export async function generateOutline(
  supabase: SupabaseClient,
  input: { topic: string; style: VideoStyle; targetMinutes: number; brief: string; research?: ResearchDossier | null },
): Promise<{ outline: ScriptOutline; extras: BriefExtras; research: ResearchDossier | null }> {
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  const ctx = withWritingModel(resolved.ctx, resolved.options);
  const { data } = await resolved.provider.generateJson(
    {
      system:
        'You are a documentary story editor. You turn a creator\'s notes into a tight, gripping outline, keeping their intent, structure and voice, and never inventing facts.',
      prompt: buildOutlinePrompt(input),
      schema: OutlineSchema,
    },
    ctx,
  );
  const research = mergeBriefFacts(input.research ?? null, input.topic, data.brief_facts ?? []);
  const outline = normalizeOutline(data, new Set(research?.facts.map((f) => f.id) ?? []));
  if (outline.chapters.length === 0) throw new Error('The outline came back with no chapters.');
  return {
    outline,
    research,
    extras: {
      title_ideas: cleanList(data.title_ideas, 10),
      thumbnail_ideas: cleanList(data.thumbnail_ideas, 10),
      sources: cleanList(data.sources, 30),
    },
  };
}
