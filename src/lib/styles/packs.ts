import type { CaptionPreset } from '@/pipeline/assembly/captions';
import type { Mood } from '@/pipeline/assembly/music-library';
import {
  AUTOMOTIVE,
  BUSINESS,
  COSMOS,
  DOCUMENTARY,
  HISTORY,
  MONEY,
  MYSTERY,
  NOIR,
  REVIEW,
  STADIUM,
  TECH,
  VOX,
  WARM,
  type MotionTheme,
} from './themes';

/**
 * Style packs: everything about one video style in one place, so a new niche is one entry here.
 * The id is stored in videos.style (text). Every stage reads its part: the script writer
 * (voice), the narrator (delivery), the shot director (notes, graphics share), the graphics
 * (theme), mastering (theme.grade), music (fallback mood), and new videos' starting settings.
 */

export type StyleGroup = 'explainer' | 'story' | 'niche';

export interface NarrationPacing {
  /** Speech speed for voices that support it (Kokoro, ElevenLabs); 1 is the voice's normal pace. */
  speed: number;
  /** Silence added after each sentence, in seconds (needs the voice's word timings, as Kokoro gives). */
  sentencePauseSec: number;
  /** Pause between beats for new videos in the style, in seconds. */
  beatPauseSec: number;
}

/** A little slower, with room to breathe: for story-led and documentary styles. */
const DOCUMENTARY_PACING: NarrationPacing = { speed: 0.9, sentencePauseSec: 0.35, beatPauseSec: 1.0 };

export interface StylePack {
  /** videos.style value. */
  id: string;
  /** Card title on the new-video page. */
  name: string;
  /** Longer label used in prompts and lists. */
  label: string;
  /** One line under the name on the new-video page. */
  description: string;
  /** Short name and tagline on the narrators page. */
  shortName: string;
  tagline: string;
  icon: string;
  group: StyleGroup;
  /** The writer's voice: prepended to the shared script structure rules. */
  voice: string;
  /** How the narrator should sound (sent to voices that take direction, e.g. Gemini). */
  delivery: string;
  /** Graphics colours, fonts and the master's colour grade. */
  theme: MotionTheme;
  /** Music mood when the story-matched plan can't be made. */
  fallbackMood: Mood;
  /** Extra guidance for the shot director: which shots suit this kind of video. */
  directorNotes?: string;
  /** Share of screen time graphics may take (the rhythm check's limit); default 0.55. */
  maxGraphicsShare?: number;
  /**
   * Documentary narration: slower speech and a breath after every sentence. Fixed on a video when
   * its voicing job is created, so existing videos keep the pace they were voiced at.
   */
  narration?: NarrationPacing;
  /** Starting settings for new videos in this style (changeable per video). */
  defaults?: { captionPreset?: CaptionPreset; transition?: 'cut' | 'crossfade' | 'dip_black' | 'dip_white' | 'wipe' };
}

const pack = <T extends StylePack>(p: T) => p;

export const STYLE_PACKS = {
  tech: pack({
    id: 'tech',
    name: 'Tech Explainer',
    label: 'Tech explainer (fast, Fireship-style)',
    description: 'Fast-paced, punchy hook, rapid delivery with dry humor and technical clarity.',
    shortName: 'Tech Explainer',
    tagline: 'Fast-paced, authoritative technical breakdown',
    icon: '⚡',
    group: 'explainer',
    voice: `You write fast-paced tech explainer scripts in the style of Fireship:
punchy opening hook in the first 3 seconds, rapid-fire delivery, dry humor,
technical accuracy without over-explaining, and a strong opinionated take by
the end rather than a neutral summary. Assume the viewer already codes.
Short sentences. No filler.`,
    delivery: 'Fast, crisp and confident, with dry wit; like a sharp tech YouTuber talking to developers.',
    theme: TECH,
    fallbackMood: 'curious',
  }),

  cinematic: pack({
    id: 'cinematic',
    name: 'Cinematic Documentary',
    label: 'Cinematic documentary (ColdFusion-style)',
    description: 'Atmospheric pacing, descriptive depth, and thoughtful narrative build toward a payoff.',
    shortName: 'Cinematic Doc',
    tagline: 'Deep, atmospheric, dramatic storytelling',
    icon: '🎬',
    group: 'story',
    voice: `You write cinematic documentary-style scripts in the style of ColdFusion:
measured, atmospheric pacing, longer descriptive sentences, a sense of scale
and consequence, framing the topic as a larger story about technology and
society rather than a quick tutorial. Build tension toward a payoff.`,
    delivery: 'Measured, atmospheric documentary narration with gravitas; let key lines breathe.',
    theme: DOCUMENTARY,
    fallbackMood: 'mysterious',
    narration: DOCUMENTARY_PACING,
  }),

  modernmba: pack({
    id: 'modernmba',
    name: 'Business & Data Analysis',
    label: 'Business/data analysis (modernmba-style)',
    description: 'Structured around a thesis backed by hard data, financial metrics, and market dynamics.',
    shortName: 'Business Analysis',
    tagline: 'Polished, strategic, corporate insight',
    icon: '📊',
    group: 'explainer',
    voice: `You write business/strategy analysis scripts in the style of Modern MBA:
structured around a central thesis, backed by specific numbers and
comparisons, walks through cause-and-effect business reasoning, ends with a
clear takeaway or prediction. Favor charts and data visuals over b-roll
wherever a claim can be shown as a number.`,
    delivery: 'Clear, confident business analyst; steady pace, lean on the numbers.',
    theme: BUSINESS,
    fallbackMood: 'curious',
  }),

  listicle: pack({
    id: 'listicle',
    name: 'Listicle / Countdown',
    label: 'Listicle / countdown',
    description: 'Brisk, numbered items with snappy justifications and high-retention pacing.',
    shortName: 'Listicle / Fast Facts',
    tagline: 'Energetic, punchy, high-retention pacing',
    icon: '📋',
    group: 'explainer',
    voice: `You write countdown/listicle scripts (e.g. "Top 5", "Top 10").
Open with a hook stating what the list is and why it matters, then count
down (or up) through clearly numbered items, each with a short punchy
justification. Keep pacing brisk between items — no long tangents per item.
Close with a quick recap or a "which was your favorite" style beat.`,
    delivery: 'Energetic and upbeat countdown host; punchy, quick rhythm.',
    theme: WARM,
    fallbackMood: 'curious',
  }),

  story_driven: pack({
    id: 'story_driven',
    name: 'Story-Driven Deep Dive',
    label: 'Story-driven deep dive',
    description: 'Compelling narrative arc with setup, rising stakes, turning points, and resolution.',
    shortName: 'Story Driven',
    tagline: 'Immersive narrative with emotional arc',
    icon: '📖',
    group: 'story',
    voice: `You write narrative deep-dive scripts built around a single story with a
clear arc: setup, rising complication, turning point, resolution. Use
scene-setting detail and follow a chronological or cause-and-effect thread
rather than a list of facts. Withhold the full picture early to create
narrative pull toward the payoff.`,
    delivery: 'Warm, engaging storyteller building tension; slow down for turning points.',
    theme: DOCUMENTARY,
    fallbackMood: 'mysterious',
    narration: DOCUMENTARY_PACING,
  }),

  comparison: pack({
    id: 'comparison',
    name: 'Comparison Breakdown',
    label: 'Comparison / "X vs Y" breakdown',
    description: 'Head-to-head analysis evaluating cost, capabilities, tradeoffs, and a definitive verdict.',
    shortName: 'Head-to-Head',
    tagline: 'Balanced, analytical, objective comparison',
    icon: '⚖️',
    group: 'explainer',
    voice: `You write head-to-head comparison scripts ("X vs Y"). Establish both sides
fairly before taking a position, structure the middle around clear
comparison criteria (cost, performance, use case, etc. — whatever fits the
topic), and end with a clear verdict or "it depends" framing backed by the
criteria you walked through. Avoid strawmanning either side.`,
    delivery: 'Even-handed and analytical, then decisive for the verdict.',
    theme: BUSINESS,
    fallbackMood: 'curious',
  }),

  eli5: pack({
    id: 'eli5',
    name: 'ELI5 / Beginner Explainer',
    label: 'ELI5 / beginner explainer',
    description: 'Accessible analogies, patient conversational tone, and step-by-step clarity with zero jargon.',
    shortName: "Explain Like I'm 5",
    tagline: 'Warm, approachable, simplified breakdown',
    icon: '💡',
    group: 'explainer',
    voice: `You write beginner-friendly explainer scripts. Assume zero prior knowledge.
Use concrete analogies for abstract concepts, define any term before using
it, build understanding incrementally (simple idea first, then add
complexity), and keep sentences short. Warmth and patience in tone, never
condescending.`,
    delivery: 'Warm, friendly and patient, like explaining to a curious friend; never condescending.',
    theme: WARM,
    fallbackMood: 'curious',
  }),

  true_crime_pov: pack({
    id: 'true_crime_pov',
    name: 'Investigative / POV',
    label: 'True crime / POV explainer',
    description: 'Suspenseful narrative delivery, atmospheric timeline reconstruction, and building dread.',
    shortName: 'True Crime POV',
    tagline: 'Dark, tense, suspenseful first-person atmosphere',
    icon: '🔍',
    group: 'story',
    voice: `You write true-crime-style narrative scripts, told with a slow-building,
suspenseful POV delivery: present tense or close narrative voice, deliberate
pacing that withholds key details, atmospheric description of setting and
timeline, and a sense of dread or tension building toward the reveal.
Stick strictly to verifiable facts where the topic concerns real events —
flag clearly in the text if any detail is disputed or unconfirmed rather
than dramatizing it as fact.`,
    delivery: 'Low, tense and suspenseful; deliberate pacing with quiet dread.',
    theme: NOIR,
    fallbackMood: 'tense',
    narration: DOCUMENTARY_PACING,
  }),

  vox_explainer: pack({
    id: 'vox_explainer',
    name: 'Vox Explainer',
    label: 'Vox-style visual explainer',
    description: 'One clear question, answered with evidence: charts, maps, archival proof, and a "here\'s why it matters" payoff.',
    shortName: 'Vox Explainer',
    tagline: 'Curious, conversational, evidence-driven',
    icon: '🧭',
    group: 'explainer',
    voice: `You write visual explainer scripts in the style of Vox and Johnny Harris.
Open with a concrete, slightly puzzling observation and turn it into one clear
question the whole video answers. Answer it like a reporter building a case:
each beat adds one piece of evidence (a number, a map, a document, a quote, a
historical moment) and says why it matters. Narrate *to* the visuals: refer to
what the viewer is looking at ("look at this line", "this is London in 1931")
so charts, maps, and documents carry the argument. Conversational, curious,
plain-spoken, never academic; short sentences with an occasional longer one
for rhythm. Zoom out near the end to the bigger pattern, then land on a payoff
that answers the opening question.`,
    delivery: 'Curious, conversational explainer; plain-spoken and engaged, as if walking the viewer through evidence.',
    theme: VOX,
    fallbackMood: 'curious',
  }),

  // ------------------------------------------------------------------------
  // Niche packs
  // ------------------------------------------------------------------------

  car: pack({
    id: 'car',
    name: 'Car Culture',
    label: 'Car culture / automotive',
    description: 'Machines, rivalries and engineering told with enthusiast energy; specs as head-to-heads.',
    shortName: 'Car Culture',
    tagline: 'Enthusiast energy, specs and stories',
    icon: '🏎️',
    group: 'niche',
    voice: `You write car-culture scripts for enthusiasts, in the spirit of channels like
Donut Media and Hagerty: energetic, knowledgeable and fun, but never sloppy with
facts. Tell the story behind the machine (the engineers, the rivalry, the race,
the price tag) and explain the engineering in plain words a non-mechanic can
follow. Specs (horsepower, torque, 0-60 or 0-100 times, top speed, weight, price)
come only from the research, with units and the model year; never mix figures
from different versions or markets of a car. Opinions are welcome when they are
clearly framed as opinions.`,
    delivery: 'Energetic, knowledgeable enthusiast; punchy on the specs, warmer on the stories.',
    theme: AUTOMOTIVE,
    fallbackMood: 'triumphant',
    maxGraphicsShare: 0.45,
    directorNotes: `Car videos live on footage: favour stock b-roll of driving and details (tracking shots on open roads, engine bays, wheels, gauges, assembly lines) with concrete queries such as "sports car tracking shot mountain road" or "engine bay close-up". Show specs as "comparison" (one car vs another, or old vs new) and "stat" (horsepower, 0-60 time, top speed, price). Use "timeline" for a model's generations and "diagram" for how a part works (turbocharger, gearbox, aerodynamics). Stock footage rarely shows the exact model, so never put a caption or annotation naming a specific make or model on stock; use those only on archive photos.`,
    defaults: { captionPreset: 'social_pop', transition: 'cut' },
  }),

  sport: pack({
    id: 'sport',
    name: 'Sports Story',
    label: 'Sports storytelling',
    description: 'Matches, seasons and rivalries with broadcast tension and stat-driven graphics.',
    shortName: 'Sports Story',
    tagline: 'Broadcast tension, records and rivalries',
    icon: '🏆',
    group: 'niche',
    voice: `You write sports storytelling scripts: a match, a season, a career or a rivalry,
told with the tension of a live broadcast and the depth of a documentary. Set the
stakes early, build toward the decisive moment, and use statistics to show what
made it remarkable. Scores, records, dates and quotes come only from the research;
never invent a quote, a score or a "record", and never round a record. Respect the
people involved: no mocking injuries, private lives or rival fans.`,
    delivery: 'Charged, broadcast-style storyteller; build tension into the big moments.',
    theme: STADIUM,
    fallbackMood: 'triumphant',
    narration: DOCUMENTARY_PACING,
    directorNotes: `Show records and results as "stat", head-to-heads between players or teams as "comparison", and a season or career as "timeline"; use "geo_map" for host cities and tournament routes. Stock b-roll should be generic and atmospheric ("stadium crowd at night floodlights", "football on wet grass close-up", "runner's feet on track"). Stock never shows the real players, so never caption or annotate stock footage with an athlete's or team's name; names belong on archive photos only.`,
    defaults: { captionPreset: 'social_pop', transition: 'cut' },
  }),

  finance: pack({
    id: 'finance',
    name: 'Money & Finance',
    label: 'Personal finance / markets',
    description: 'Calm, practical money explainers with real numbers, charts and the risks spelled out.',
    shortName: 'Money & Finance',
    tagline: 'Calm, practical, numbers-first',
    icon: '💰',
    group: 'niche',
    voice: `You write personal-finance and markets explainers: clear, calm and practical,
for viewers who want to understand money, not be sold to. Explain one idea at a
time with a concrete example in real numbers (state the currency and the year).
Always show the risk alongside the upside. Never tell the viewer to buy or sell a
specific investment and never promise returns; frame takeaways as principles.
Prices, rates and dates come only from the research.`,
    delivery: 'Calm, clear and trustworthy; steady pace, careful with numbers.',
    theme: MONEY,
    fallbackMood: 'curious',
    maxGraphicsShare: 0.6,
    directorNotes: `Numbers carry finance videos: use "chart" for prices, rates or balances over time, "comparison" for two options side by side (renting vs buying, saving vs investing), "stat" for one striking figure, and "diagram" for mechanisms (how compound interest grows: process; the inflation spiral: cycle). Stock b-roll: concrete and calm ("coins stacking close-up", "person reviewing bills at kitchen table", "financial district skyline at dusk"). Never show a company logo or ticker the narration doesn't name.`,
    defaults: { captionPreset: 'clean_news', transition: 'cut' },
  }),

  space_science: pack({
    id: 'space_science',
    name: 'Space & Science',
    label: 'Space & science explainer',
    description: 'Scale, wonder and evidence: diagrams, comparisons and NASA imagery.',
    shortName: 'Space & Science',
    tagline: 'Awe, scale and evidence',
    icon: '🪐',
    group: 'niche',
    voice: `You write space and science explainers that make the viewer feel the scale of
things: wonder grounded in evidence. Start from something familiar, then zoom out
(or in) step by step, using comparisons the ear can picture ("if the Sun were a
beach ball..."). Explain how we know, not just what we know, and say clearly where
the science is still uncertain or debated. Numbers carry units and are rounded for
the ear; they come only from the research.`,
    delivery: 'Awe-struck but precise; unhurried, letting big numbers land.',
    theme: COSMOS,
    fallbackMood: 'hopeful',
    maxGraphicsShare: 0.5,
    directorNotes: `Use "diagram" for processes (how a star forms: process; the water or carbon cycle: cycle; what's inside a planet: breakdown), "comparison" for scale (Earth vs Jupiter), and "stat" for distances, ages and sizes. Real imagery beats illustration: prefer "archive" for NASA, ESA and observatory photos (e.g. "Hubble image Pillars of Creation", "Apollo 11 lunar surface 1969"), and stock for night skies, labs and rocket launches. An artist's impression must never be presented as a photo.`,
    defaults: { captionPreset: 'vox', transition: 'crossfade' },
  }),

  tech_review: pack({
    id: 'tech_review',
    name: 'Tech Review',
    label: 'Tech product review',
    description: "What it is, who it's for, the good, the bad, and a clear verdict.",
    shortName: 'Tech Review',
    tagline: 'Honest verdicts, clear trade-offs',
    icon: '📱',
    group: 'niche',
    voice: `You write tech product review scripts in the voice of a trusted reviewer: what
it is, who it's for, what's genuinely good, what isn't, and a clear verdict. Build
the middle around what matters in daily use (design, display, performance,
battery, camera, software, price: whatever fits the product). Specs and prices
come only from the research, with the exact model name. You have not used the
product yourself: present test results as reported and attribute them. Be fair:
no hype and no pile-ons; say when the answer depends on the buyer.`,
    delivery: 'Crisp, honest reviewer; conversational and confident.',
    theme: REVIEW,
    fallbackMood: 'curious',
    maxGraphicsShare: 0.5,
    directorNotes: `Specs belong in "comparison" (this model vs last year's, or vs its rival) and "stat" (battery hours, price, weight). A "diagram" breakdown suits what's inside (centre: the device; parts: chip, battery, cameras). Use "screen_recording" when the narration names a website or app. Stock b-roll: generic and tactile ("smartphone on wooden desk close-up", "hands typing on laptop keyboard", "earbuds charging case"). Stock rarely shows the exact product, so never caption or annotate stock with a product or brand name.`,
    defaults: { captionPreset: 'clean_news', transition: 'cut' },
  }),

  history: pack({
    id: 'history',
    name: 'History Documentary',
    label: 'Narrative history',
    description: 'Real people and turning points, anchored in dates, maps and primary sources.',
    shortName: 'History Doc',
    tagline: 'Turning points, people and primary sources',
    icon: '🏺',
    group: 'story',
    voice: `You write narrative history documentaries: a real past brought to life through
people, places and turning points. Anchor every scene in time and place (dates,
locations, who was there), explain causes and consequences, and let primary
sources speak through short attributed quotes when the research has them.
Separate what historians know from what they still debate. Never put invented
words in a historical figure's mouth.`,
    delivery: 'Grave, warm documentary narrator; measured, with weight on turning points.',
    theme: HISTORY,
    fallbackMood: 'mysterious',
    narration: DOCUMENTARY_PACING,
    maxGraphicsShare: 0.5,
    directorNotes: `History is told through the archive: favour "archive" photos, paintings, documents and film of the period, with annotations on the people and places that matter. Use "timeline" for sequences of events, "geo_map" for campaigns, empires and journeys, "quote" for attributed primary sources, and "newspaper" when the research quotes a headline. Use stock only for landscapes and places as they look today, never as stand-ins for the past.`,
    defaults: { captionPreset: 'vox', transition: 'crossfade' },
  }),

  mystery: pack({
    id: 'mystery',
    name: 'Unsolved Mystery',
    label: 'Mystery / unsolved',
    description: 'Atmospheric case reconstructions with every theory weighed fairly.',
    shortName: 'Unsolved Mystery',
    tagline: 'Atmospheric, fair to every theory',
    icon: '🕵️',
    group: 'story',
    voice: `You write unsolved-mystery scripts: atmospheric, patient and fair. Reconstruct
what is known in order, then lay out each theory with the evidence for and
against it, making clear which details are documented and which are rumour or
speculation. Build intrigue from what remains unexplained, never from invented
details. Treat real victims and their families with respect: no gore, and no
blame without evidence.`,
    delivery: 'Hushed, intrigued and deliberate; let unanswered questions hang.',
    theme: MYSTERY,
    fallbackMood: 'mysterious',
    narration: DOCUMENTARY_PACING,
    maxGraphicsShare: 0.45,
    directorNotes: `Reconstruct events with "timeline", locate them with "geo_map" (mode "locate"), and quote documents or witnesses with "quote" when the research attributes them. Footage should be atmospheric and non-graphic ("foggy forest path at dusk", "old case files on desk", "empty road at night"); archive photos of real places and documents are best. When laying out competing theories, a "comparison" can set two explanations side by side. Never show anything that looks like a real victim unless it is an archive photo the research names.`,
    defaults: { captionPreset: 'vox', transition: 'dip_black' },
  }),
} as const satisfies Record<string, StylePack>;

export type VideoStyle = keyof typeof STYLE_PACKS;

export const STYLE_IDS = Object.keys(STYLE_PACKS) as VideoStyle[];

export const STYLE_GROUP_LABELS: Record<StyleGroup, string> = {
  explainer: 'Explainers',
  story: 'Story & documentary',
  niche: 'Niches',
};

export function isVideoStyle(style: unknown): style is VideoStyle {
  return typeof style === 'string' && Object.prototype.hasOwnProperty.call(STYLE_PACKS, style);
}

/**
 * A new video's script_json with its style's starting settings (caption style, transition),
 * stored where the visuals page keeps them. Settings already present are kept.
 */
export function withStyleDefaults<T extends object>(scriptJson: T, style: string | null | undefined): T {
  const pack = stylePack(style);
  const defaults = pack?.defaults;
  const beatPause = pack?.narration?.beatPauseSec;
  if (!defaults && beatPause === undefined) return scriptJson;
  const current = scriptJson as T & { captions?: unknown; transition?: unknown; beat_pause_seconds?: unknown };
  return {
    ...scriptJson,
    ...(defaults?.captionPreset && current.captions === undefined ? { captions: { preset: defaults.captionPreset } } : {}),
    ...(defaults?.transition && current.transition === undefined ? { transition: defaults.transition } : {}),
    ...(beatPause !== undefined && current.beat_pause_seconds === undefined ? { beat_pause_seconds: beatPause } : {}),
  };
}

/** Typical length of a spoken sentence, used to estimate how much the sentence pauses add. */
const TYPICAL_SENTENCE_SEC = 6;

/**
 * How much of the usual words-per-second a style's narration delivers (1 for normal pacing): a
 * 0.9 speed with a 0.35 s breath per sentence comes out at about 0.85. Script budgets use it so
 * a target length still comes out at that length.
 */
export function narrationPaceFactor(style: string | null | undefined): number {
  const pacing = stylePack(style)?.narration;
  if (!pacing) return 1;
  return Math.round((pacing.speed / (1 + pacing.sentencePauseSec / TYPICAL_SENTENCE_SEC)) * 1000) / 1000;
}

/**
 * The pause for a pacing mark (an ellipsis the writer put in for effect): longer in documentary
 * styles, where lines are meant to land, than in fast explainers.
 */
export function dramaticPauseSec(style: string | null | undefined): number {
  return stylePack(style)?.narration ? 0.8 : 0.5;
}

/** The pack for a stored style, or undefined for unknown/legacy values. */
export function stylePack(style: string | null | undefined): StylePack | undefined {
  return isVideoStyle(style) ? STYLE_PACKS[style] : undefined;
}
