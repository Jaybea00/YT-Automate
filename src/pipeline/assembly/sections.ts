import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScriptBeat } from '@/lib/script/generate-script';
import type { LLMProvider, ProviderCallContext } from '../providers/types';
import type { Section } from './pacing';

/**
 * Sections are the story's parts. They become the YouTube chapters and set where pacing gives a
 * longer pause with a dip to black. Planned once per script and saved as script_json.sections.
 */

const MIN_BEATS_PER_SECTION = 4;
const MAX_SECTIONS = 8;
const TARGET_BEATS_PER_SECTION = 10;
const MAX_TITLE_LENGTH = 48;

export interface SavedSections {
  sections: Section[];
  source: 'title_cards' | 'llm' | 'even';
  /** Which script these were planned for, so edits to the script re-plan them. */
  signature: string;
}

/** Changes when beats are added, removed or rewritten. */
export function scriptSignature(beats: Array<{ text: string }>): string {
  let h = 0;
  for (const b of beats) {
    for (let i = 0; i < b.text.length; i++) h = (Math.imul(h, 31) + b.text.charCodeAt(i)) | 0;
  }
  return `${beats.length}:${(h >>> 0).toString(36)}`;
}

const cleanTitle = (t: string) => {
  const s = t.replace(/["“”*_#`]/g, '').replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/, '');
  return s.length > MAX_TITLE_LENGTH ? `${s.slice(0, MAX_TITLE_LENGTH - 1).trim()}…` : s;
};

/**
 * Keeps sections usable: sorted, starting at beat 0, at least MIN_BEATS_PER_SECTION apart (a
 * too-short section merges into the one before), titled, and at most MAX_SECTIONS.
 */
export function normalizeSections(sections: Section[], beatCount: number): Section[] {
  const sorted = [...sections]
    .filter((s) => Number.isInteger(s.start_beat) && s.start_beat >= 0 && s.start_beat < beatCount)
    .sort((a, b) => a.start_beat - b.start_beat);
  const out: Section[] = [];
  for (const s of sorted) {
    const title = cleanTitle(s.title);
    if (!title) continue;
    if (out.length === 0) {
      out.push({ start_beat: 0, title: s.start_beat === 0 ? title : 'Introduction' });
      if (s.start_beat === 0) continue;
    }
    if (s.start_beat - out[out.length - 1].start_beat < MIN_BEATS_PER_SECTION) continue;
    out.push({ start_beat: s.start_beat, title });
  }
  // The last section needs room too
  while (out.length > 1 && beatCount - out[out.length - 1].start_beat < MIN_BEATS_PER_SECTION) out.pop();
  return out.slice(0, MAX_SECTIONS);
}

/** Sections from the director's chapter cards ("title" shots), when the script has some. */
export function sectionsFromTitleCards(beats: ScriptBeat[]): Section[] | null {
  const cards = beats.flatMap((b, pos) =>
    (b.shots ?? []).filter((s) => s.visual_type === 'title' && s.title_card?.text).slice(0, 1).map((s) => ({ start_beat: pos, title: s.title_card!.text })),
  );
  if (cards.length === 0) return null;
  const sections = normalizeSections([{ start_beat: 0, title: 'Introduction' }, ...cards], beats.length);
  return sections.length >= 2 ? sections : null;
}

/** Even split, titled from each section's opening line, when nothing better is available. */
export function evenSections(beats: Array<{ text: string }>): Section[] {
  const count = Math.max(1, Math.min(MAX_SECTIONS, Math.round(beats.length / TARGET_BEATS_PER_SECTION)));
  const size = Math.ceil(beats.length / count);
  return normalizeSections(
    Array.from({ length: count }, (_, i) => {
      const start = i * size;
      const opening = (beats[start]?.text ?? '').split(/[.?!]/)[0];
      return { start_beat: start, title: i === 0 ? 'Introduction' : opening.split(/\s+/).slice(0, 6).join(' ') };
    }),
    beats.length,
  );
}

const SectionsSchema = z.object({
  sections: z.array(z.object({ start_beat: z.number(), title: z.string() })),
});

/** Has the LLM split the story into its parts and title them like YouTube chapters. */
export async function planSectionsWithLlm(
  beats: Array<{ text: string }>,
  topic: string,
  llm: LLMProvider,
  ctx: ProviderCallContext,
): Promise<Section[]> {
  const target = Math.max(3, Math.min(MAX_SECTIONS, Math.round(beats.length / TARGET_BEATS_PER_SECTION)));
  const { data } = await llm.generateJson(
    {
      system: 'You are the editor of a documentary YouTube channel. You split narration into chapters.',
      prompt: `Video topic: "${topic}"

Split this narration into about ${target} chapters at the points where the story moves to a new part (a new time, place, idea or question). Each chapter must span at least ${MIN_BEATS_PER_SECTION} beats; the first starts at beat 0.
Title each chapter like a YouTube chapter: 2-6 words, specific and intriguing, no numbering, no quotes. The first is the opening (not "Introduction" unless nothing fits better).

${beats.map((b, i) => `[${i}] ${b.text}`).join('\n')}

Return {"sections": [{"start_beat": number, "title": string}]}.`,
      schema: SectionsSchema,
    },
    ctx,
  );
  return normalizeSections(data.sections, beats.length);
}

/**
 * The script's sections, planned and saved if missing or stale. Never throws: if planning
 * fails, an even split is used.
 */
export async function ensureSections(options: {
  supabase: SupabaseClient;
  videoId: string;
  scriptJson: { beats?: ScriptBeat[]; sections?: SavedSections } & Record<string, unknown>;
  topic?: string;
  llm?: { provider: LLMProvider; ctx: ProviderCallContext } | null;
}): Promise<Section[]> {
  const { supabase, videoId, scriptJson, topic = '', llm } = options;
  const beats = scriptJson.beats ?? [];
  if (beats.length === 0) return [];
  const signature = scriptSignature(beats);
  if (scriptJson.sections?.signature === signature && scriptJson.sections.sections?.length) {
    return scriptJson.sections.sections;
  }

  let saved: SavedSections;
  const fromCards = sectionsFromTitleCards(beats);
  if (fromCards) {
    saved = { sections: fromCards, source: 'title_cards', signature };
  } else {
    let planned: Section[] | null = null;
    if (llm && beats.length >= MIN_BEATS_PER_SECTION * 2) {
      planned = await planSectionsWithLlm(beats, topic, llm.provider, llm.ctx).catch((err) => {
        console.warn(`[Sections] Planning with the LLM failed; splitting evenly: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
        return null;
      });
    }
    saved = planned && planned.length >= 2
      ? { sections: planned, source: 'llm', signature }
      : { sections: evenSections(beats), source: 'even', signature };
  }

  // Merge into the latest script_json so a concurrent edit elsewhere isn't overwritten
  const { data: fresh } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  const { error } = await supabase
    .from('videos')
    .update({ script_json: { ...(fresh?.script_json ?? scriptJson), sections: saved } })
    .eq('id', videoId);
  if (error) console.warn(`[Sections] Could not save sections: ${error.message}`);
  console.log(`[Sections] ${saved.sections.length} sections (${saved.source}): ${saved.sections.map((s) => `${s.start_beat} ${s.title}`).join(' | ')}`);
  return saved.sections;
}
