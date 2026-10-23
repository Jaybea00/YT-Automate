import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider } from '@/pipeline/providers/types';
import { groundedTitles, TITLE_MAX_CHARS } from '@/pipeline/publish/metadata';
import type { ResearchDossier } from '@/lib/research/types';
import { STYLE_TEMPLATES, type VideoStyle } from './style-templates';
import { withWritingModel } from './generate-script';
import type { PackageOption, Packaging } from './packaging-types';

export { chosenPackage, leadWithPackageTitle, type PackageOption, type Packaging } from './packaging-types';

/**
 * Packaging first: the title and thumbnail are decided before the script, the way successful
 * channels work, and the script is written to pay off exactly that promise.
 */

const PackagingSchema = z.object({
  options: z.array(
    z.object({
      title: z.string(),
      thumbnail_image: z.string(),
      thumbnail_text: z.string(),
      promise: z.string(),
      angle: z.string(),
    }),
  ),
});

export function buildPackagingPrompt(input: {
  topic: string;
  style: VideoStyle;
  targetMinutes: number;
  research?: ResearchDossier | null;
  brief?: string | null;
}): string {
  const style = STYLE_TEMPLATES[input.style];
  const facts = input.research?.facts.length
    ? `\nVerified facts:\n${input.research.facts.slice(0, 30).map((f) => `- ${f.claim}`).join('\n')}`
    : '';
  const brief = input.brief?.trim() ? `\nThe creator's brief (use their title or thumbnail ideas if it has them):\n"""\n${input.brief.trim().slice(0, 4000)}\n"""` : '';
  return `Package a YouTube video before its script is written.
Topic: "${input.topic}"
Style: ${style?.label ?? input.style}, ~${input.targetMinutes} minutes${brief}${facts}

Write 4 packaging options, best first. Each is a title and thumbnail that work together and make one clear, honest promise the video can keep:
- title: under 60 characters ideally, never over ${TITLE_MAX_CHARS}; specific nouns and numbers beat hype; no ALL CAPS words except acronyms, no emoji. Any figure must come from the facts or brief.
- thumbnail_image: the one image (a person's face with an expression, an object, a scene) that makes someone stop scrolling.
- thumbnail_text: 2-4 words on the thumbnail that add intrigue the title doesn't already say (never repeat the title), or "" for none.
- promise: one sentence on what the viewer will get, the question the video answers.
- angle: curiosity, stakes, story, mystery, contrarian, or number.
Use different angles across the options. Never promise what the facts can't deliver.`;
}

/** Usable options only: a title within YouTube's limit, no figure the research doesn't back. */
export function normalizePackaging(raw: z.infer<typeof PackagingSchema>['options'], ground: string): PackageOption[] {
  const seen = new Set<string>();
  const options: PackageOption[] = [];
  for (const o of raw) {
    const title = o.title.replace(/\s+/g, ' ').replace(/^["“']+|["”']+$/g, '').trim();
    if (!title || title.length > TITLE_MAX_CHARS || seen.has(title.toLowerCase())) continue;
    if (groundedTitles([{ text: title, angle: '' }], ground).length === 0) continue;
    seen.add(title.toLowerCase());
    options.push({
      title,
      thumbnail_image: o.thumbnail_image.trim(),
      thumbnail_text: o.thumbnail_text.replace(/^["“']+|["”']+$/g, '').trim().split(/\s+/).slice(0, 5).join(' '),
      promise: o.promise.trim(),
      angle: o.angle.trim().toLowerCase() || 'curiosity',
    });
  }
  return options.slice(0, 4);
}

export async function generatePackaging(
  supabase: SupabaseClient,
  input: { topic: string; style: VideoStyle; targetMinutes: number; research?: ResearchDossier | null; brief?: string | null },
): Promise<Packaging | null> {
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  const { data } = await resolved.provider.generateJson(
    {
      system: 'You package YouTube videos: titles and thumbnails that earn the click honestly.',
      prompt: buildPackagingPrompt(input),
      schema: PackagingSchema,
    },
    withWritingModel(resolved.ctx, resolved.options),
  );
  const ground = [input.topic, input.brief ?? '', ...(input.research?.facts.map((f) => f.claim) ?? [])].join(' ');
  const options = normalizePackaging(data.options, ground);
  return options.length ? { options, chosen: 0 } : null;
}

/** Packaging never blocks the script: without it the script is written as before. */
export async function generatePackagingOrNull(
  supabase: SupabaseClient,
  input: Parameters<typeof generatePackaging>[1],
): Promise<Packaging | null> {
  try {
    const packaging = await generatePackaging(supabase, input);
    if (packaging) console.log(`[packaging] Chose "${packaging.options[0].title}" from ${packaging.options.length} options`);
    return packaging;
  } catch (err) {
    console.warn('[packaging] Packaging failed; writing the script without it:', err instanceof Error ? err.message.slice(0, 200) : err);
    return null;
  }
}
