/**
 * One entry per value in the `video_style` Postgres enum (see
 * supabase/migrations/0001_init_schema.sql + 0002_expand_video_styles.sql).
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
  | 'true_crime_pov';

export interface StyleTemplate {
  name: string;
  label: string;
  description: string;
  /** Injected as the system prompt for script generation. */
  systemPrompt: string;
}

const BEAT_STRUCTURE_INSTRUCTIONS = `
Return the script as JSON only — no prose before or after, no markdown fences.

Shape:
{
  "title_options": string[],       // 3 candidate titles
  "beats": [
    {
      "index": number,
      "text": string,              // the narration line(s) for this beat
      "visual_type": "screen_recording" | "stock" | "chart" | "geo_map" | "archive" | "newspaper",
      "visual_query": string,      // what to search/record for this beat
                                    // e.g. "headline from Wall Street Journal on crash" for newspaper,
                                    // "flight route from London to New York" for geo_map,
                                    // "bar chart: revenue by quarter" for chart,
                                    // "historical archival photos of 1920s" for archive,
                                    // "GitHub repo page for X" for screen_recording,
                                    // "aerial shot of city traffic" for stock
      "duration_estimate_seconds": number
    }
  ]
}

Classify every beat's visual_type honestly:
- "newspaper" when citing news reports, press releases, articles, declarations, or headlines.
- "geo_map" when discussing travel, geographic routes, locations, territory, or distances.
- "chart" when stating specific statistics, numbers, percentages, or data comparisons.
- "archive" for historical footage, century-old photos, public domain documents, or NASA space missions.
- "screen_recording" only when referencing a specific real, named website/tool/product shown live.
- "stock" for general cinematic b-roll and abstract concepts.

Duration discipline: the sum of every beat's duration_estimate_seconds must
not exceed the requested target runtime by more than 5%. Before finalizing,
add up your own duration estimates and trim beats (shorten lines, merge
beats, or cut a lower-priority one) if the total runs over. Err on the side
of slightly under the target rather than over.
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
descending. ${BEAT_STRUCTURE_INSTRUCTIONS}`,
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
};