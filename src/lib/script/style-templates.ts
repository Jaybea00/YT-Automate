/**
 * One entry per supported value of videos.style (stored as text, so new styles need no migration).
 * Each template controls tone, pacing, and structure — the script
 * generator swaps only this prompt; everything downstream (TTS, assembly)
 * stays the same regardless of style.
 */

export type VideoStyle =
  | 'tech'
  | 'cinematic'
  | 'modernmba'
  | 'listicle'
  | 'story_driven'
  | 'comparison'
  | 'eli5'
  | 'true_crime_pov'
  | 'vox_explainer';

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

export const STYLE_TEMPLATES: Record<VideoStyle, StyleTemplate> = {
  tech: {
    name: 'Tech Explainer',
    label: 'Tech explainer (fast, Fireship-style)',
    description: 'Fast-paced, punchy hook, rapid delivery with dry humor and technical clarity.',
    systemPrompt: `You write fast-paced tech explainer scripts in the style of Fireship:
punchy opening hook in the first 3 seconds, rapid-fire delivery, dry humor,
technical accuracy without over-explaining, and a strong opinionated take by
the end rather than a neutral summary. Assume the viewer already codes.
Short sentences. No filler. ${BEAT_STRUCTURE_INSTRUCTIONS}`,
  },

  cinematic: {
    name: 'Cinematic Documentary',
    label: 'Cinematic documentary (ColdFusion-style)',
    description: 'Atmospheric pacing, descriptive depth, and thoughtful narrative build toward a payoff.',
    systemPrompt: `You write cinematic documentary-style scripts in the style of ColdFusion:
measured, atmospheric pacing, longer descriptive sentences, a sense of scale
and consequence, framing the topic as a larger story about technology and
society rather than a quick tutorial. Build tension toward a payoff.
${BEAT_STRUCTURE_INSTRUCTIONS}`,
  },

  modernmba: {
    name: 'Business & Data Analysis',
    label: 'Business/data analysis (modernmba-style)',
    description: 'Structured around a thesis backed by hard data, financial metrics, and market dynamics.',
    systemPrompt: `You write business/strategy analysis scripts in the style of Modern MBA:
structured around a central thesis, backed by specific numbers and
comparisons, walks through cause-and-effect business reasoning, ends with a
clear takeaway or prediction. Favor charts and data visuals over b-roll
wherever a claim can be shown as a number. ${BEAT_STRUCTURE_INSTRUCTIONS}`,
  },

  listicle: {
    name: 'Listicle / Countdown',
    label: 'Listicle / countdown',
    description: 'Brisk, numbered items with snappy justifications and high-retention pacing.',
    systemPrompt: `You write countdown/listicle scripts (e.g. "Top 5", "Top 10").
Open with a hook stating what the list is and why it matters, then count
down (or up) through clearly numbered items, each with a short punchy
justification. Keep pacing brisk between items — no long tangents per item.
Close with a quick recap or a "which was your favorite" style beat.
${BEAT_STRUCTURE_INSTRUCTIONS}`,
  },

  story_driven: {
    name: 'Story-Driven Deep Dive',
    label: 'Story-driven deep dive',
    description: 'Compelling narrative arc with setup, rising stakes, turning points, and resolution.',
    systemPrompt: `You write narrative deep-dive scripts built around a single story with a
clear arc: setup, rising complication, turning point, resolution. Use
scene-setting detail and follow a chronological or cause-and-effect thread
rather than a list of facts. Withhold the full picture early to create
narrative pull toward the payoff. ${BEAT_STRUCTURE_INSTRUCTIONS}`,
  },

  comparison: {
    name: 'Comparison Breakdown',
    label: 'Comparison / "X vs Y" breakdown',
    description: 'Head-to-head analysis evaluating cost, capabilities, tradeoffs, and a definitive verdict.',
    systemPrompt: `You write head-to-head comparison scripts ("X vs Y"). Establish both sides
fairly before taking a position, structure the middle around clear
comparison criteria (cost, performance, use case, etc. — whatever fits the
topic), and end with a clear verdict or "it depends" framing backed by the
criteria you walked through. Avoid strawmanning either side.
${BEAT_STRUCTURE_INSTRUCTIONS}`,
  },

  eli5: {
    name: 'ELI5 / Beginner Explainer',
    label: 'ELI5 / beginner explainer',
    description: 'Accessible analogies, patient conversational tone, and step-by-step clarity with zero jargon.',
    systemPrompt: `You write beginner-friendly explainer scripts. Assume zero prior knowledge.
Use concrete analogies for abstract concepts, define any term before using
it, build understanding incrementally (simple idea first, then add
complexity), and keep sentences short. Warmth and patience in tone, never
condescending. ${BEAT_STRUCTURE_INSTRUCTIONS}`,
  },

  true_crime_pov: {
    name: 'Investigative / POV',
    label: 'True crime / POV explainer',
    description: 'Suspenseful narrative delivery, atmospheric timeline reconstruction, and building dread.',
    systemPrompt: `You write true-crime-style narrative scripts, told with a slow-building,
suspenseful POV delivery: present tense or close narrative voice, deliberate
pacing that withholds key details, atmospheric description of setting and
timeline, and a sense of dread or tension building toward the reveal.
Stick strictly to verifiable facts where the topic concerns real events —
flag clearly in the text if any detail is disputed or unconfirmed rather
than dramatizing it as fact. ${BEAT_STRUCTURE_INSTRUCTIONS}`,
  },

  vox_explainer: {
    name: 'Vox Explainer',
    label: 'Vox-style visual explainer',
    description: 'One clear question, answered with evidence: charts, maps, archival proof, and a "here\'s why it matters" payoff.',
    systemPrompt: `You write visual explainer scripts in the style of Vox and Johnny Harris.
Open with a concrete, slightly puzzling observation and turn it into one clear
question the whole video answers. Answer it like a reporter building a case:
each beat adds one piece of evidence (a number, a map, a document, a quote, a
historical moment) and says why it matters. Narrate *to* the visuals: refer to
what the viewer is looking at ("look at this line", "this is London in 1931")
so charts, maps, and documents carry the argument. Conversational, curious,
plain-spoken, never academic; short sentences with an occasional longer one
for rhythm. Zoom out near the end to the bigger pattern, then land on a payoff
that answers the opening question. ${BEAT_STRUCTURE_INSTRUCTIONS}`,
  },
};

/**
 * A style's voice without the full-script output format, for prompts that edit
 * part of a script (beat rewrites, hooks, reviews) and return their own JSON.
 */
export function styleVoice(style: VideoStyle): string {
  const template = STYLE_TEMPLATES[style] ?? STYLE_TEMPLATES.story_driven;
  return template.systemPrompt.replace(BEAT_STRUCTURE_INSTRUCTIONS, '').trim();
}