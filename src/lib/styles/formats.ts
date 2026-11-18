import type { Mood } from '@/pipeline/assembly/music-library';
import type { StylePack, VideoStyle } from './packs';

/**
 * Formats: how a video is BUILT (its structure, pace and emphasis), independent of what it is
 * about. A video's style is a format plus a niche (niches.ts), with an optional look and audience;
 * compose.ts combines them into the StylePack every stage reads.
 */

export type SignatureShot = NonNullable<StylePack['signatureShots']>[number];

/**
 * fast: brisk writing, the narrator's normal speed. normal: the narrator's normal speed (a slow
 * niche such as History makes it documentary). documentary: slower speech with a breath after
 * every sentence.
 */
export type FormatPacing = 'fast' | 'normal' | 'documentary';

export interface FormatDef {
  id: string;
  name: string;
  icon: string;
  /** One line on the new-video page. */
  description: string;
  /** The writer's structure rules: how the script is built, beat by beat. */
  structure: string;
  /** The narrator's energy, added to the niche's manner. */
  energy: string;
  pacing: FormatPacing;
  emphasis?: StylePack['emphasis'];
  /** Signature shots that come with the structure (an evidence board for an investigation). */
  signatureShots?: SignatureShot[];
  /** Shot director guidance that comes with the structure (title cards for time jumps). */
  directorNotes?: string;
  chartCallouts?: boolean;
  /** Music mood when the niche doesn't set one (the General niche). */
  mood?: Mood;
  /** The runtime this format usually works best at, in minutes. */
  suggestedMinutes: number;
  /** The closest original style, used when the niche doesn't name one. */
  baseStyle: VideoStyle;
  /** Made by the creator on the packs page (stored in storage/settings/style-library.json). */
  custom?: boolean;
}

export const BUILT_IN_FORMATS: FormatDef[] = [
  {
    id: 'explainer',
    name: 'Explainer',
    icon: '🧭',
    description: 'One clear question, answered piece by piece with evidence, landing on why it matters.',
    structure: `You write visual explainer scripts. Open with a concrete, slightly puzzling observation and
turn it into one clear question the whole video answers. Answer it like a reporter building a case:
each beat adds one piece of evidence (a number, a map, a document, a quote, a historical moment) and
says why it matters. Narrate *to* the visuals: refer to what the viewer is looking at ("look at this
line", "this is London in 1931") so charts, maps and documents carry the argument. Conversational,
curious and plain-spoken, never academic; short sentences with an occasional longer one for rhythm.
Zoom out near the end to the bigger pattern, then land on a payoff that answers the opening question.`,
    energy: 'Curious and conversational, as if walking the viewer through the evidence.',
    pacing: 'normal',
    emphasis: { chapterZoom: true },
    suggestedMinutes: 10,
    baseStyle: 'vox_explainer',
  },
  {
    id: 'analysis',
    name: 'Analysis',
    icon: '📊',
    description: 'A central thesis backed by hard numbers, cause and effect, and a clear takeaway or prediction.',
    structure: `You write analysis scripts structured around one central thesis, stated early. Back it with
specific numbers and comparisons, walk through the cause-and-effect reasoning step by step, address the
strongest counter-argument, and end with a clear takeaway or prediction. Favour charts and data visuals
over b-roll wherever a claim can be shown as a number.`,
    energy: 'Clear and confident; a steady pace that leans on the numbers.',
    pacing: 'normal',
    emphasis: { chapterZoom: true },
    chartCallouts: true,
    suggestedMinutes: 12,
    baseStyle: 'modernmba',
  },
  {
    id: 'story',
    name: 'Story',
    icon: '📖',
    description: 'A narrative arc: setup, rising stakes, a turning point and a resolution.',
    structure: `You write narrative scripts built around a single story with a clear arc: setup, rising
complication, turning point, resolution. Use scene-setting detail (who, where, when) and follow a
chronological or cause-and-effect thread rather than a list of facts. Build a sense of scale and
consequence, and withhold the full picture early to create narrative pull toward the payoff.`,
    energy: 'A storyteller building tension; slow down for the turning points and let key lines breathe.',
    pacing: 'documentary',
    emphasis: { letterbox: true },
    mood: 'mysterious',
    suggestedMinutes: 15,
    baseStyle: 'story_driven',
  },
  {
    id: 'investigation',
    name: 'Investigation',
    icon: '🔍',
    description: 'Reconstruct what is known, then weigh every theory fairly against the evidence.',
    structure: `You write investigation scripts. Reconstruct what is known in order, with a slow-building,
suspenseful delivery that withholds key details until they matter and describes the setting and
timeline atmospherically. Then lay out each theory or explanation with the evidence for and against it,
making clear which details are documented and which are rumour or speculation. Build intrigue from what
remains unexplained, never from invented details, and end on what the evidence most supports (or why
the question is still open).`,
    energy: 'Deliberate and suspenseful; let unanswered questions hang.',
    pacing: 'documentary',
    emphasis: { letterbox: true },
    signatureShots: ['evidence_board'],
    mood: 'mysterious',
    suggestedMinutes: 15,
    baseStyle: 'mystery',
  },
  {
    id: 'pov',
    name: 'POV',
    icon: '🧍',
    description: 'The viewer is the main character: "You wake up in ancient Rome…"',
    structure: `You write POV scripts in the second person: the viewer IS the main character ("You wake up in
a Roman barracks..."). Walk them through the experience in time order (a day, a journey, a career, a
life) with concrete sensory details, real facts woven in, light humour, and a new danger, twist or
surprise about every minute. Mark time jumps clearly ("Day three.", "Ten years later.").`,
    energy: 'Lively, talking straight to the viewer, with a smile in the voice.',
    pacing: 'normal',
    emphasis: { chapterZoom: true },
    directorNotes: `Mark time jumps with "title" cards (text "Day 1" or "Year 10", kicker the place and date, e.g. "Rome, 73 BC"). Show survival odds, wages, distances and other single numbers as "stat", then-versus-now figures as "comparison", and journeys as "geo_map".`,
    suggestedMinutes: 10,
    baseStyle: 'story_driven',
  },
  {
    id: 'countdown',
    name: 'Countdown',
    icon: '📋',
    description: 'Numbered items with snappy justifications, building to the best one.',
    structure: `You write countdown/listicle scripts (e.g. "Top 5", "Top 10"). Open with a hook stating what
the list is and why it matters, then count down (or up) through clearly numbered items, each with a
short punchy justification and one concrete detail that makes it stick. Save the strongest item for
last. Keep pacing brisk between items, with no long tangents. Close with a quick recap.`,
    energy: 'Energetic and upbeat; punchy, with a quick rhythm between items.',
    pacing: 'fast',
    emphasis: { chapterZoom: true },
    suggestedMinutes: 10,
    baseStyle: 'listicle',
  },
  {
    id: 'comparison',
    name: 'Comparison',
    icon: '⚖️',
    description: 'X vs Y: both sides fairly, clear criteria, and a definitive verdict.',
    structure: `You write head-to-head comparison scripts ("X vs Y"). Establish both sides fairly before taking
a position, structure the middle around clear comparison criteria (cost, performance, use case:
whatever fits the topic), and end with a clear verdict or an "it depends" framing backed by the criteria
you walked through. Avoid strawmanning either side.`,
    energy: 'Even-handed and analytical, then decisive for the verdict.',
    pacing: 'normal',
    emphasis: { chapterZoom: true },
    signatureShots: ['race_bars', 'spec_card'],
    suggestedMinutes: 10,
    baseStyle: 'comparison',
  },
  {
    id: 'review',
    name: 'Review',
    icon: '⭐',
    description: "What it is, who it's for, the good, the bad, and a clear verdict.",
    structure: `You write review scripts in the voice of a trusted reviewer: what it is, who it's for, what's
genuinely good, what isn't, and a clear verdict. Build the middle around what matters in real use
(whatever fits the subject: design, performance, value, comfort, durability). Specs and prices come only
from the research, with the exact model or edition name. You have not used it yourself: present test
results and opinions as reported and attribute them. Be fair: no hype and no pile-ons; say when the
answer depends on the buyer.`,
    energy: 'Crisp, honest and conversational.',
    pacing: 'normal',
    emphasis: { chapterZoom: true },
    signatureShots: ['spec_card', 'race_bars'],
    suggestedMinutes: 10,
    baseStyle: 'tech_review',
  },
  {
    id: 'retelling',
    name: 'Retelling',
    icon: '📜',
    description: 'A faithful retelling of a source text (scripture, a myth, a book) in its own order.',
    structure: `You write faithful retellings of a source text (a scripture passage, a myth, a book, a famous
speech). Follow the order of the text and say where you are in it as the story moves. Keep what the
characters say close to the source; when you quote word for word, say where the quote comes from.
Background and context come only from the research, and interpretation stays clearly separate from what
the text says ("Many readers see this as..."). Never invent events, speeches or details the source does
not give.`,
    energy: 'Calm and clear; unhurried, with gentle weight on the key moments.',
    pacing: 'documentary',
    suggestedMinutes: 10,
    baseStyle: 'history',
  },
  {
    id: 'quick_take',
    name: 'Quick Take',
    icon: '⚡',
    description: 'Rapid-fire, dry humour, and a strong opinion by the end. Best short.',
    structure: `You write fast-paced quick-take scripts: a punchy opening hook in the first 3 seconds,
rapid-fire delivery, dry humour, accuracy without over-explaining, and a strong opinionated take by the
end rather than a neutral summary. Short sentences. No filler.`,
    energy: 'Fast, crisp and confident, with dry wit.',
    pacing: 'fast',
    emphasis: { chapterZoom: true },
    suggestedMinutes: 5,
    baseStyle: 'tech',
  },
];
