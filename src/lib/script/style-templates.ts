import { STYLE_PACKS, type VideoStyle } from '@/lib/styles/packs';

/**
 * One script template per style pack (src/lib/styles/packs.ts, where styles are defined). Each
 * controls tone, pacing and structure: the pack's voice plus the shared structure rules below.
 */

export type { VideoStyle };

export interface StyleTemplate {
  name: string;
  label: string;
  description: string;
  /** Injected as the system prompt for script generation. */
  systemPrompt: string;
}

/**
 * Visual-type rules shared by every path that assigns visuals to beats:
 * fresh scripts, AI-segmented uploads, and visual-hint enrichment.
 */
export const VISUAL_TYPE_RULES = `
VISUAL TYPES — choose per beat, following these rules strictly:
- "chart": ONLY when the beat states at least two specific numbers that compare or change over time. visual_query must restate them with units, e.g. "line chart: Dow Jones 1921 = 64, Sep 1929 = 381".
- "geo_map": ONLY when the point of the beat is where things are or how something moves between named places at city, country, or continent scale (routes, spread, borders). Never street- or building-level. visual_query lists the places in order, e.g. "map: New York -> London -> Vienna -> Berlin".
- "newspaper": ONLY when the narration explicitly cites a specific publication's headline or article (names the outlet and what it said). visual_query: "outlet | date | exact headline". A person's quote to "the press" is NOT a newspaper beat.
- "archive": real historical photos or film likely held in public archives (events before ~1970, government or NASA footage). visual_query: concrete searchable nouns plus year, e.g. "1929 crowd outside New York Stock Exchange".
- "screen_recording": ONLY when the narration names a specific real website or app viewers should see live. visual_query: the product name or URL.
- "stock": everything else. visual_query: 3-6 concrete, filmable nouns (no abstract concepts), e.g. "closed bank doors, line of people, rain".
- Variety keeps viewers watching: never use the same visual_type for more than 3 beats in a row.
`.trim();

/** Writing rules shared by full-script generation and single-beat editing. */
export const RETENTION_CRAFT = `
RETENTION CRAFT (applies to every style):
- Beat 0 is the hook: open on the most surprising concrete moment, stake, or question, in 20 words or fewer. No greetings, no "in this video", no channel intro.
- Open a loop early (a question the video promises to answer) and pay it off near the end.
- Roughly every 45-60 seconds of narration, re-hook with a turn, a reveal, or a new question.
- One idea per beat, 12-35 words. Write for the ear: short spoken sentences, varied rhythm.
- Prefer concrete specifics (names, numbers, dates, places) over generalities.
- Close on a memorable line that resolves the opening loop. No "like and subscribe".
- Never invent quotes, statistics, or events. If a figure is uncertain, attribute or hedge it.
`.trim();

const BEAT_STRUCTURE_INSTRUCTIONS = `
${RETENTION_CRAFT}

LENGTH: the user message gives a word budget for the narration. The total words across all beat "text" fields must land inside it. Hitting the budget matters as much as quality — add substance (specific details, examples, consequences), never filler.

${VISUAL_TYPE_RULES}

Return the script as JSON only — no prose before or after, no markdown fences.

Shape:
{
  "title_options": string[],       // 3 candidate titles, under 60 characters, curiosity-driven but accurate
  "beats": [
    {
      "index": number,             // 0, 1, 2, ...
      "text": string,              // the narration for this beat
      "visual_type": "screen_recording" | "stock" | "chart" | "geo_map" | "archive" | "newspaper",
      "visual_query": string,      // follows the rules above for the chosen visual_type
      "duration_estimate_seconds": number,
      "fact_ids": string[]         // research fact ids this beat uses, when a dossier is provided
    }
  ]
}
`.trim();

/** Script templates for every style pack: the pack's voice, then the shared structure rules. */
export const STYLE_TEMPLATES = Object.fromEntries(
  Object.values(STYLE_PACKS).map((p) => [
    p.id,
    { name: p.name, label: p.label, description: p.description, systemPrompt: `${p.voice}\n${BEAT_STRUCTURE_INSTRUCTIONS}` },
  ]),
) as Record<VideoStyle, StyleTemplate>;

/**
 * A style's voice without the full-script output format, for prompts that edit
 * part of a script (beat rewrites, hooks, reviews) and return their own JSON.
 */
export function styleVoice(style: VideoStyle): string {
  const template = STYLE_TEMPLATES[style] ?? STYLE_TEMPLATES.story_driven;
  return template.systemPrompt.replace(BEAT_STRUCTURE_INSTRUCTIONS, '').trim();
}