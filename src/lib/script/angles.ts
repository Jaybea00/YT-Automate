import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider, ProviderCallContext } from '@/pipeline/providers/types';
import { groundedTitles, TITLE_MAX_CHARS } from '@/pipeline/publish/metadata';
import type { StylePack } from '@/lib/styles/packs';
import { withWritingModel } from './generate-script';
import { ANGLE_KINDS, type VideoAngle } from './angle-brief';

export { ANGLE_KINDS, briefForAngle, type VideoAngle } from './angle-brief';

/**
 * "Find angles": before anything is researched or written, turn a rough topic into a few
 * distinct angles, each with the title, thumbnail and hook it would be packaged with. The chosen
 * angle becomes the video's working title and brief.
 */

const AngleSchema = z.object({
  angles: z.array(
    z.object({
      title: z.string(),
      hook: z.string(),
      angle: z.string(),
      kind: z.string(),
      thumbnail: z.string(),
      thumbnail_text: z.string(),
      why: z.string(),
    }),
  ),
});

export const MAX_ANGLES = 6;

export function buildAnglesPrompt(input: { topic: string; notes?: string | null; pack?: StylePack | null; targetMinutes?: number | null }): string {
  const style = input.pack ? `\nFormat and niche: ${input.pack.label} (${input.pack.description})` : '';
  const length = input.targetMinutes ? `\nLength: about ${input.targetMinutes} minutes` : '';
  const notes = input.notes?.trim() ? `\nThe creator's notes:\n"""\n${input.notes.trim().slice(0, 3000)}\n"""` : '';
  return `A YouTube creator has a rough topic and wants the strongest angle before anything is researched or written.
Topic: "${input.topic}"${style}${length}${notes}

Suggest ${MAX_ANGLES} genuinely different angles on this topic, best first. Each is a specific framing a viewer could not get from a generic overview: a question, a story, a surprising consequence, a contrarian take, a comparison, a "how did this happen".
For each:
- title: the YouTube title it would be packaged with, under 60 characters ideally (never over ${TITLE_MAX_CHARS}); specific nouns beat hype; no ALL CAPS words except acronyms, no emoji.
- hook: the first line of narration (20 words or fewer): the most surprising concrete moment, stake or question.
- angle: one sentence on what makes this angle different from the others.
- kind: one of ${ANGLE_KINDS.join(', ')}.
- thumbnail: the one image (a face with an expression, an object, a scene) that would stop the scroll.
- thumbnail_text: 2-4 words on the thumbnail that add intrigue the title doesn't already say, or "".
- why: one sentence on why viewers would click and keep watching.
Nothing has been researched yet: never state a specific number, date, record or quote in a title or hook unless the topic or notes give it. Frame angles as questions and stories the research will fill in. Every angle must be something a well-researched video could honestly deliver.`;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^["“']+|["”']+$/g, '').trim();

/** Usable angles only: distinct titles within YouTube's limit, no figure the topic doesn't give. */
export function normalizeAngles(raw: z.infer<typeof AngleSchema>['angles'], ground: string): VideoAngle[] {
  const seen = new Set<string>();
  const out: VideoAngle[] = [];
  for (const a of raw) {
    const title = clean(a.title);
    if (!title || title.length > TITLE_MAX_CHARS || seen.has(title.toLowerCase())) continue;
    // A title with a figure the topic doesn't give would promise something unchecked
    if (groundedTitles([{ text: title, angle: '' }], ground).length === 0) continue;
    seen.add(title.toLowerCase());
    const kind = (ANGLE_KINDS as readonly string[]).includes(a.kind.trim().toLowerCase()) ? (a.kind.trim().toLowerCase() as VideoAngle['kind']) : 'curiosity';
    out.push({
      title,
      hook: clean(a.hook),
      angle: clean(a.angle),
      kind,
      thumbnail: clean(a.thumbnail),
      thumbnail_text: clean(a.thumbnail_text).split(/\s+/).filter(Boolean).slice(0, 5).join(' '),
      why: clean(a.why),
    });
  }
  return out.slice(0, MAX_ANGLES);
}

export async function suggestAnglesWith(
  llm: LLMProvider,
  ctx: ProviderCallContext,
  input: { topic: string; notes?: string | null; pack?: StylePack | null; targetMinutes?: number | null },
): Promise<VideoAngle[]> {
  const { data } = await llm.generateJson(
    {
      system: 'You are a YouTube strategist who finds the angle that makes a topic worth clicking, honestly.',
      prompt: buildAnglesPrompt(input),
      schema: AngleSchema,
    },
    ctx,
  );
  return normalizeAngles(data.angles ?? [], `${input.topic} ${input.notes ?? ''}`);
}

export async function suggestAngles(
  supabase: SupabaseClient,
  input: { topic: string; notes?: string | null; pack?: StylePack | null; targetMinutes?: number | null },
): Promise<VideoAngle[]> {
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  return suggestAnglesWith(resolved.provider, withWritingModel(resolved.ctx, resolved.options), input);
}
