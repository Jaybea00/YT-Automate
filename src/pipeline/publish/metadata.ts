import { z } from 'zod';
import { numbersIn } from '@/lib/script/shot-planner';
import type { LLMProvider, ProviderCallContext } from '../providers/types';

/**
 * YouTube metadata: title options, a description that hooks in its first lines and then carries
 * the chapters and required credits, tags and hashtags. The LLM writes the words; YouTube's limits
 * and the factual parts (chapters, credits) are applied in code.
 */

export const TITLE_IDEAL_CHARS = 60;
export const TITLE_MAX_CHARS = 100;
export const DESCRIPTION_MAX_CHARS = 5000;
/** YouTube's limit on all tags together. */
export const TAGS_MAX_CHARS = 500;
/** YouTube shows the first three hashtags above the title. */
const MAX_HASHTAGS = 3;

export interface TitleOption {
  text: string;
  /** The hook it uses: curiosity, stakes, number, question, story. */
  angle: string;
}

export interface VideoMetadata {
  titles: TitleOption[];
  /** The opening lines (shown before "...more") and a short summary. */
  hook: string;
  summary: string;
  tags: string[];
  hashtags: string[];
  generatedAt: string;
}

const MetadataSchema = z.object({
  titles: z.array(z.object({ text: z.string(), angle: z.string() })),
  hook: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  hashtags: z.array(z.string()),
});

const cleanTitle = (t: string) => t.replace(/\s+/g, ' ').replace(/^["“']+|["”']+$/g, '').trim();
const cleanTag = (t: string) => t.replace(/[#<>,"]/g, '').replace(/\s+/g, ' ').trim();
const cleanHashtag = (t: string) => {
  const core = t.replace(/^#+/, '').replace(/[^\p{L}\p{N}]/gu, '');
  return core ? `#${core}` : '';
};

/** Applies YouTube's limits: title length, a 500-character tag budget, three hashtags, no duplicates. */
export function normalizeMetadata(raw: z.infer<typeof MetadataSchema>): Omit<VideoMetadata, 'generatedAt'> {
  const titles: TitleOption[] = [];
  for (const t of raw.titles) {
    const text = cleanTitle(t.text);
    if (text && text.length <= TITLE_MAX_CHARS && !titles.some((x) => x.text.toLowerCase() === text.toLowerCase())) {
      titles.push({ text, angle: t.angle.trim().toLowerCase() || 'statement' });
    }
  }
  // Shorter titles first among equals: they aren't cut off in search and suggestions
  titles.sort((a, b) => Number(a.text.length > TITLE_IDEAL_CHARS) - Number(b.text.length > TITLE_IDEAL_CHARS));

  const tags: string[] = [];
  let budget = TAGS_MAX_CHARS;
  for (const t of raw.tags.map(cleanTag)) {
    // YouTube counts a tag with spaces as if quoted (+2) and a comma between tags (+1)
    const cost = t.length + (t.includes(' ') ? 2 : 0) + (tags.length ? 1 : 0);
    if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase()) || cost > budget) continue;
    tags.push(t);
    budget -= cost;
  }

  const hashtags = [...new Set(raw.hashtags.map(cleanHashtag).filter(Boolean))].slice(0, MAX_HASHTAGS);
  return { titles: titles.slice(0, 5), hook: raw.hook.trim(), summary: raw.summary.trim(), tags, hashtags };
}

/**
 * The full description: hook, summary, chapters, credits, hashtags, in the order YouTube shows
 * them, cut to the 5,000-character limit without dropping the chapters or credits.
 */
export function composeDescription(parts: { hook: string; summary: string; chapters?: string; sources?: string; credits?: string; hashtags?: string[] }): string {
  const tail = [
    parts.chapters ? `Chapters:\n${parts.chapters}` : '',
    parts.sources ? `Sources:\n${parts.sources}` : '',
    parts.credits ? `Credits:\n${parts.credits}` : '',
    parts.hashtags?.length ? parts.hashtags.join(' ') : '',
  ].filter(Boolean);
  const tailText = tail.join('\n\n');
  const room = DESCRIPTION_MAX_CHARS - tailText.length - 4;
  let head = [parts.hook, parts.summary].filter(Boolean).join('\n\n');
  if (head.length > room) head = `${head.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return [head, tailText].filter(Boolean).join('\n\n');
}

/**
 * The description's source list: the sources the creator listed in a brief, then the researched
 * sources the script actually cites. Empty for videos without research or a brief.
 */
export function descriptionSources(scriptJson: {
  brief_extras?: { sources?: string[] };
  beats?: Array<{ fact_ids?: string[] }>;
  research?: {
    facts?: Array<{ id: string; sourceIds: string[] }>;
    sources?: Array<{ id: string; title: string; url: string }>;
  };
}): string {
  const lines = [...(scriptJson.brief_extras?.sources ?? [])];
  const cited = new Set((scriptJson.beats ?? []).flatMap((b) => b.fact_ids ?? []));
  const sourceIds = new Set(
    (scriptJson.research?.facts ?? []).filter((f) => cited.has(f.id)).flatMap((f) => f.sourceIds),
  );
  for (const s of scriptJson.research?.sources ?? []) {
    // Sources without a link (the creator's brief itself) and ones the creator already listed are skipped
    if (!s.url || !sourceIds.has(s.id) || lines.some((l) => l.includes(s.url))) continue;
    lines.push(`${s.title}: ${s.url}`);
  }
  return [...new Set(lines.map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean))]
    .map((l) => `- ${l}`)
    .join('\n');
}

export async function generateMetadata(options: {
  topic: string;
  style?: string | null;
  narration: string[];
  sectionTitles?: string[];
  facts?: string[];
  currentTitle?: string | null;
  /** Title ideas from the creator's brief. */
  creatorTitles?: string[];
  llm: LLMProvider;
  ctx: ProviderCallContext;
}): Promise<VideoMetadata> {
  const { topic, style, narration, sectionTitles = [], facts = [], currentTitle, creatorTitles = [], llm, ctx } = options;
  const script = narration.join(' ');
  const { data } = await llm.generateJson(
    {
      system:
        'You package documentary videos for YouTube. You write titles and descriptions that earn the click honestly: specific, intriguing, and true to the video. Never promise what the video does not deliver.',
      prompt: `Topic: "${topic}"${style ? `\nStyle: ${style}` : ''}${currentTitle ? `\nWorking title: "${currentTitle}"` : ''}
${creatorTitles.length ? `The creator's own title ideas: ${creatorTitles.map((t) => `"${t}"`).join(', ')}. Include the strongest of them among the 5 (fitted to the rules below) and let them guide the others.\n` : ''}${sectionTitles.length ? `Chapters: ${sectionTitles.join(' | ')}\n` : ''}${facts.length ? `Verified facts:\n${facts.slice(0, 15).map((f) => `- ${f}`).join('\n')}\n` : ''}
Narration:
${script.slice(0, 9000)}

Write:
- titles: 5 options, each using a different angle ("curiosity", "stakes", "number", "question", "story"). Aim for under ${TITLE_IDEAL_CHARS} characters, never over ${TITLE_MAX_CHARS}. Specific nouns and numbers from the video beat vague hype. No ALL CAPS words except acronyms, no emoji, no "you won't believe".
- hook: the first 1-2 sentences of the description (about 150 characters), the most intriguing true thing about the video; they show above "...more".
- summary: 2-4 sentences on what the viewer will learn, naming the key people, places and numbers.
- tags: 12-18 search phrases a viewer would type, from specific to broad.
- hashtags: 3, broad topics, no spaces.
Only facts stated in the narration or the verified facts.`,
      schema: MetadataSchema,
    },
    ctx,
  );
  const normalized = normalizeMetadata(data);
  // A title never states a figure the video doesn't
  const grounded = groundedTitles(normalized.titles, [script, ...facts].join(' '));
  return { ...normalized, titles: grounded.length ? grounded : normalized.titles.filter((t) => digitFigures(t.text).length === 0), generatedAt: new Date().toISOString() };
}

/**
 * Figures written in digits ("16 Million", "1929"). In a title, words like "one" are phrasing
 * ("One Day"), not claims, so only digits are checked.
 */
function digitFigures(text: string): number[] {
  return numbersIn(text.replace(/\b[a-z]+\b/gi, (w) => (/^(thousand|million|billion|trillion)$/i.test(w) ? w : ' ')));
}

/** Titles whose every figure appears in the narration or facts (where spelled-out numbers count). */
export function groundedTitles(titles: TitleOption[], ground: string): TitleOption[] {
  const pool = numbersIn(ground);
  const stated = (n: number) => pool.some((p) => Math.abs(p - n) <= Math.abs(p) * 0.005 + 1e-9);
  return titles.filter((t) => digitFigures(t.text).every(stated));
}
