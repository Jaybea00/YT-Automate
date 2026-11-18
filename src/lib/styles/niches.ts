import type { CaptionPreset } from '@/pipeline/assembly/captions';
import type { Mood } from '@/pipeline/assembly/music-library';
import type { SignatureShot } from './formats';
import type { VideoStyle } from './packs';

/**
 * Niches: what a video is ABOUT, and how it looks and sounds (subject rules, shot director notes,
 * theme, music mood). A video's style is a format (formats.ts) plus a niche; compose.ts combines
 * them.
 */

export interface NicheDef {
  id: string;
  name: string;
  icon: string;
  /** One line on the new-video page. */
  description: string;
  /** The writer's subject rules: accuracy, sensitivity, what to anchor claims in. Empty for General. */
  subject: string;
  /** The narrator's manner for this subject (the format adds its energy). */
  delivery: string;
  /** Theme name (themes.ts): colours, fonts and the master's colour grade. */
  theme: string;
  /** The theme when the video is drawn (the Drawings look); default: the doodle theme. */
  drawnTheme?: string;
  fallbackMood: Mood;
  /** Slower, documentary narration unless the format is a fast one. */
  slowNarration?: boolean;
  /** The narrator's normal pace even in documentary formats (an energetic subject). */
  briskNarration?: boolean;
  /** Emphasis that suits the subject, instead of the format's. */
  emphasis?: { letterbox?: boolean; chapterZoom?: boolean };
  directorNotes?: string;
  maxGraphicsShare?: number;
  signatureShots?: SignatureShot[];
  /** Labelled AI illustrations may stand in for what no camera could capture. */
  illustrations?: boolean;
  chartCallouts?: boolean;
  captionPreset?: CaptionPreset;
  /** Formats that suit this niche best, shown first on the new-video page. */
  suggestedFormats: string[];
  /** The closest original style (transitions, sound palette), or null to use the format's. */
  baseStyle: VideoStyle | null;
  custom?: boolean;
}

export const BUILT_IN_NICHES: NicheDef[] = [
  {
    id: 'general',
    name: 'General',
    icon: '🎬',
    description: 'Any topic, no subject rules: the format and look do the work.',
    subject: '',
    delivery: '',
    theme: 'documentary',
    fallbackMood: 'curious',
    suggestedFormats: ['explainer', 'story', 'countdown', 'comparison', 'analysis'],
    baseStyle: null,
  },
  {
    id: 'tech',
    name: 'Tech',
    icon: '💻',
    description: 'Software, hardware, AI and the companies behind them.',
    subject: `The subject is technology: software, hardware, AI and the companies behind them. Be technically
accurate, and explain jargon only as far as the audience needs. Product names, versions, benchmarks and
prices come only from the research, with the exact model or version.`,
    delivery: 'Sharp and knowledgeable about technology; crisp with names and numbers.',
    theme: 'tech',
    fallbackMood: 'curious',
    directorNotes: `Use "screen_recording" when the narration names a website or app. Specs belong in "comparison" (this version vs the last, or vs its rival) and "stat"; a "diagram" breakdown suits what's inside a device or how a system fits together. Stock b-roll: generic and tactile ("hands typing on laptop keyboard", "server room lights", "smartphone on wooden desk close-up"). Stock rarely shows the exact product, so never caption or annotate stock with a product or brand name.`,
    maxGraphicsShare: 0.5,
    captionPreset: 'clean_news',
    suggestedFormats: ['quick_take', 'explainer', 'review', 'comparison', 'analysis'],
    baseStyle: 'tech',
  },
  {
    id: 'business',
    name: 'Business & Companies',
    icon: '🏢',
    description: 'Companies, founders, markets and the decisions that made or broke them.',
    subject: `The subject is business and strategy: companies, founders, markets and the decisions that made or
broke them. Back claims with specific numbers (revenue, margins, market share, valuations) stated with
the currency and year, and walk through the business reasoning behind each decision. Figures come only
from the research.`,
    delivery: 'Polished business analyst; lean on the numbers.',
    theme: 'business',
    fallbackMood: 'curious',
    signatureShots: ['money'],
    chartCallouts: true,
    suggestedFormats: ['analysis', 'story', 'comparison', 'explainer', 'countdown'],
    baseStyle: 'modernmba',
  },
  {
    id: 'finance',
    name: 'Money & Finance',
    icon: '💰',
    description: 'Practical money and markets, with real numbers and the risks spelled out.',
    subject: `The subject is personal finance and markets, for viewers who want to understand money, not be
sold to. Explain one idea at a time with a concrete example in real numbers (state the currency and the
year). Always show the risk alongside the upside. Never tell the viewer to buy or sell a specific
investment and never promise returns; frame takeaways as principles. Prices, rates and dates come only
from the research.`,
    delivery: 'Calm, clear and trustworthy; careful with numbers.',
    theme: 'money',
    fallbackMood: 'curious',
    maxGraphicsShare: 0.6,
    directorNotes: `Numbers carry finance videos: use "chart" for prices, rates or balances over time, "comparison" for two options side by side (renting vs buying, saving vs investing), "stat" for one striking figure, and "diagram" for mechanisms (how compound interest grows: process; the inflation spiral: cycle). Stock b-roll: concrete and calm ("coins stacking close-up", "person reviewing bills at kitchen table", "financial district skyline at dusk"). Never show a company logo or ticker the narration doesn't name.`,
    signatureShots: ['money'],
    chartCallouts: true,
    captionPreset: 'clean_news',
    suggestedFormats: ['explainer', 'analysis', 'comparison', 'countdown'],
    baseStyle: 'finance',
  },
  {
    id: 'cars',
    name: 'Cars',
    icon: '🏎️',
    description: 'Machines, rivalries and engineering, with enthusiast energy and specs done right.',
    subject: `The subject is cars and car culture: the machines, the engineers, the rivalries, the races and the
price tags. Explain the engineering in plain words a non-mechanic can follow. Specs (horsepower, torque,
0-60 or 0-100 times, top speed, weight, price) come only from the research, with units and the model
year; never mix figures from different versions or markets of a car. Opinions are welcome when they are
clearly framed as opinions.`,
    delivery: 'Knowledgeable enthusiast; punchy on the specs, warmer on the stories.',
    theme: 'automotive',
    fallbackMood: 'triumphant',
    briskNarration: true,
    emphasis: { chapterZoom: true },
    maxGraphicsShare: 0.45,
    directorNotes: `Car videos live on footage: favour stock b-roll of driving and details (tracking shots on open roads, engine bays, wheels, gauges, assembly lines) with concrete queries such as "sports car tracking shot mountain road" or "engine bay close-up". Show specs as "comparison" (one car vs another, or old vs new) and "stat" (horsepower, 0-60 time, top speed, price). Use "timeline" for a model's generations and "diagram" for how a part works (turbocharger, gearbox, aerodynamics). Stock footage rarely shows the exact model, so never put a caption or annotation naming a specific make or model on stock; use those only on archive photos.`,
    signatureShots: ['spec_card', 'race_bars'],
    captionPreset: 'social_pop',
    suggestedFormats: ['story', 'comparison', 'review', 'countdown'],
    baseStyle: 'car',
  },
  {
    id: 'sport',
    name: 'Sport',
    icon: '🏆',
    description: 'Matches, seasons, careers and rivalries, with broadcast tension and stats.',
    subject: `The subject is sport: a match, a season, a career or a rivalry. Set the stakes early and use
statistics to show what made it remarkable. Scores, records, dates and quotes come only from the
research; never invent a quote, a score or a "record", and never round a record. Respect the people
involved: no mocking injuries, private lives or rival fans.`,
    delivery: 'Charged, broadcast-style; build tension into the big moments.',
    theme: 'stadium',
    fallbackMood: 'triumphant',
    slowNarration: true,
    emphasis: { chapterZoom: true },
    directorNotes: `Show records and results as "stat", head-to-heads between players or teams as "comparison", and a season or career as "timeline"; use "geo_map" for host cities and tournament routes. Stock b-roll should be generic and atmospheric ("stadium crowd at night floodlights", "football on wet grass close-up", "runner's feet on track"). Stock never shows the real players, so never caption or annotate stock footage with an athlete's or team's name; names belong on archive photos only.`,
    signatureShots: ['pitch', 'race_bars', 'shot_map'],
    captionPreset: 'social_pop',
    suggestedFormats: ['story', 'countdown', 'comparison', 'analysis'],
    baseStyle: 'sport',
  },
  {
    id: 'space',
    name: 'Space & Science',
    icon: '🪐',
    description: 'Scale, wonder and evidence: how we know, not just what we know.',
    subject: `The subject is space and science. Make the viewer feel the scale of things: start from something
familiar, then zoom out (or in) step by step, using comparisons the ear can picture ("if the Sun were a
beach ball..."). Explain how we know, not just what we know, and say clearly where the science is still
uncertain or debated. Numbers carry units and are rounded for the ear; they come only from the research.`,
    delivery: 'Awe-struck but precise; let big numbers land.',
    theme: 'cosmos',
    fallbackMood: 'hopeful',
    maxGraphicsShare: 0.5,
    directorNotes: `Use "diagram" for processes (how a star forms: process; the water or carbon cycle: cycle; what's inside a planet: breakdown), "comparison" for scale (Earth vs Jupiter), and "stat" for distances, ages and sizes. Real imagery beats illustration: prefer "archive" for NASA, ESA and observatory photos (e.g. "Hubble image Pillars of Creation", "Apollo 11 lunar surface 1969"), and stock for night skies, labs and rocket launches. An artist's impression must never be presented as a photo.`,
    signatureShots: ['scale'],
    illustrations: true,
    captionPreset: 'vox',
    suggestedFormats: ['explainer', 'story', 'comparison', 'pov', 'countdown'],
    baseStyle: 'space_science',
  },
  {
    id: 'history',
    name: 'History',
    icon: '🏺',
    description: 'Real people and turning points, anchored in dates, maps and primary sources.',
    subject: `The subject is history: a real past brought to life through people, places and turning points.
Anchor every scene in time and place (dates, locations, who was there), explain causes and
consequences, and let primary sources speak through short attributed quotes when the research has them.
Separate what historians know from what they still debate. Never put invented words in a historical
figure's mouth.`,
    delivery: 'Grave, warm documentary narrator; weight on the turning points.',
    theme: 'history',
    fallbackMood: 'mysterious',
    slowNarration: true,
    maxGraphicsShare: 0.5,
    directorNotes: `History is told through the archive: favour "archive" photos, paintings, documents and film of the period, with annotations on the people and places that matter. Use "timeline" for sequences of events, "geo_map" for campaigns, empires and journeys, "quote" for attributed primary sources, and "newspaper" when the research quotes a headline. Use stock only for landscapes and places as they look today, never as stand-ins for the past.`,
    signatureShots: ['letter'],
    illustrations: true,
    captionPreset: 'vox',
    suggestedFormats: ['story', 'explainer', 'pov', 'countdown'],
    baseStyle: 'history',
  },
  {
    id: 'true_crime',
    name: 'True Crime',
    icon: '🚨',
    description: 'Real cases told with tension and restraint, respectful to the people involved.',
    subject: `The subject is real crime and the people it affected. Stick strictly to verifiable facts; flag
clearly in the text if any detail is disputed or unconfirmed rather than dramatizing it as fact. Treat
victims and their families with respect: no gore, no sensational detail, and no blame without evidence.
Name only people the research names.`,
    delivery: 'Low and tense, with quiet dread; respectful of the people involved.',
    theme: 'noir',
    fallbackMood: 'tense',
    slowNarration: true,
    maxGraphicsShare: 0.45,
    directorNotes: `Reconstruct events with "timeline", locate them with "geo_map" (mode "locate"), and quote documents or witnesses with "quote" when the research attributes them; use "newspaper" when the research quotes a headline. Footage should be atmospheric and non-graphic ("police tape at night", "old case files on desk", "empty road at night"); archive photos of real places and documents are best. Never show anything that looks like a real victim unless it is an archive photo the research names.`,
    signatureShots: ['evidence_board'],
    captionPreset: 'vox',
    suggestedFormats: ['investigation', 'story', 'pov'],
    baseStyle: 'true_crime_pov',
  },
  {
    id: 'mysteries',
    name: 'Mysteries & Unexplained',
    icon: '🕵️',
    description: 'Open questions and strange cases, with every theory weighed fairly.',
    subject: `The subject is mysteries and the unexplained: disappearances, strange events, lost places and open
questions. Make clear which details are documented and which are rumour or speculation, and give the
sceptical explanation a fair hearing. Treat real people and their families with respect: no gore, and no
blame without evidence.`,
    delivery: 'Hushed and intrigued.',
    theme: 'mystery',
    fallbackMood: 'mysterious',
    slowNarration: true,
    maxGraphicsShare: 0.45,
    directorNotes: `Reconstruct events with "timeline", locate them with "geo_map" (mode "locate"), and quote documents or witnesses with "quote" when the research attributes them. Footage should be atmospheric and non-graphic ("foggy forest path at dusk", "old case files on desk", "empty road at night"); archive photos of real places and documents are best. When laying out competing theories, a "comparison" can set two explanations side by side. Never show anything that looks like a real victim unless it is an archive photo the research names.`,
    signatureShots: ['evidence_board'],
    illustrations: true,
    captionPreset: 'vox',
    suggestedFormats: ['investigation', 'explainer', 'countdown', 'story'],
    baseStyle: 'mystery',
  },
  {
    id: 'faith',
    name: 'Faith & Scripture',
    icon: '✝️',
    description: 'Scripture and faith stories told faithfully, warmly and respectfully.',
    subject: `The subject is faith and scripture. Be faithful to the text and respectful to every viewer. Name the
book and chapter as the story moves ("In Exodus chapter fourteen..."). Keep what God and the characters
say close to Scripture; when you quote a verse word for word, quote the World English Bible and say its
reference. Historical and cultural background comes only from the research, and interpretation stays
clearly separate from what the text says.`,
    delivery: 'Warm, calm and reverent.',
    theme: 'history',
    drawnTheme: 'scroll',
    fallbackMood: 'hopeful',
    slowNarration: true,
    maxGraphicsShare: 0.4,
    directorNotes: `Use "verse" whenever the narration quotes a verse or points to a passage. Use "geo_map" for journeys (e.g. Egypt -> Sinai -> Canaan), "timeline" for generations, reigns or the days of a story, and "title" for each new part of the story.`,
    signatureShots: ['verse'],
    captionPreset: 'vox',
    suggestedFormats: ['retelling', 'story', 'explainer', 'pov'],
    baseStyle: 'history',
  },
  {
    id: 'geography',
    name: 'Geography & Geopolitics',
    icon: '🗺️',
    description: 'Borders, rivers, resources and power: why the map looks the way it does.',
    subject: `The subject is geography and geopolitics: places, borders, rivers, resources and the people and
power that shape them. Anchor every claim in a named place, and show it on a map whenever where something
is matters. Explain how geography causes what happens (trade routes, chokepoints, climate, terrain), not
just where things are. Treat contested borders and conflicts even-handedly: say who claims what, and
attribute disputed figures.`,
    delivery: 'Curious and clear, like a well-travelled guide.',
    theme: 'atlas',
    fallbackMood: 'curious',
    maxGraphicsShare: 0.6,
    directorNotes: `Maps carry geography videos: use "geo_map" generously for borders, routes, rivers and regions (city to continent scale), "stat" for populations, areas and distances, "comparison" for two countries side by side, and "chart" for trends over time. Archive photos and documents for history; stock for landscapes, ports, cities and borders as they look today ("container ship in narrow strait aerial", "mountain border road"). Never label stock footage with a specific place the footage may not show.`,
    chartCallouts: true,
    captionPreset: 'vox',
    suggestedFormats: ['explainer', 'analysis', 'countdown', 'comparison'],
    baseStyle: 'vox_explainer',
  },
  {
    id: 'disasters',
    name: 'Disasters & What Went Wrong',
    icon: '⚠️',
    description: 'Accidents, collapses and crashes: the chain of decisions behind them.',
    subject: `The subject is disasters and failures: accidents, collapses, crashes and the chain of decisions
behind them. Reconstruct the sequence from the official investigation where one exists, and explain the
technical cause in plain words. Be respectful to victims and survivors: no gore, no graphic detail, no
sensational language. Blame only what investigations found, and say clearly where findings are disputed.
Figures (casualties, times, speeds) come only from the research.`,
    delivery: 'Serious, measured and respectful; tension without sensationalism.',
    theme: 'hazard',
    fallbackMood: 'tense',
    slowNarration: true,
    maxGraphicsShare: 0.5,
    directorNotes: `Rebuild events with "timeline" (minute by minute), locate them with "geo_map", explain the failure with "diagram" (process for the chain of events, breakdown for the part that failed), and use "newspaper" when the research quotes a headline. Archive photos of the real site, aircraft, ship or structure are best; stock only for atmosphere ("cockpit instruments at night", "storm over the sea", "control room monitors"). Never show footage that looks like a real victim, and never label stock footage as the real event.`,
    captionPreset: 'clean_news',
    suggestedFormats: ['story', 'investigation', 'explainer', 'countdown'],
    baseStyle: 'cinematic',
  },
  {
    id: 'engineering',
    name: 'Engineering & How It Works',
    icon: '⚙️',
    description: 'Machines, structures and systems: the clever idea inside, one mechanism at a time.',
    subject: `The subject is engineering and how things work: machines, structures, systems and the clever ideas
inside them. Build understanding from a familiar starting point to the clever part, one mechanism at a
time, and say why it was designed that way (the problem, the trade-off). Use real numbers with units for
size, speed, force and cost, from the research only. Name the engineers and companies when the research
does.`,
    delivery: 'Enthusiastic and precise, delighted by clever solutions.',
    theme: 'blueprint',
    fallbackMood: 'curious',
    maxGraphicsShare: 0.6,
    directorNotes: `Diagrams carry engineering videos: "diagram" for mechanisms (process for how it works step by step, breakdown for its parts, cycle for loops), "stat" for one striking figure, "comparison" for scale or old vs new, and "timeline" for how it developed. Stock b-roll: concrete and mechanical ("gears turning macro", "bridge construction crane timelapse", "factory robot arm welding"). Archive for historic builds. Never caption stock with a specific product or structure it may not show.`,
    signatureShots: ['spec_card', 'scale'],
    illustrations: true,
    captionPreset: 'clean_news',
    suggestedFormats: ['explainer', 'story', 'comparison', 'countdown'],
    baseStyle: 'tech',
  },
  {
    id: 'psychology',
    name: 'Psychology & Self-Improvement',
    icon: '🧠',
    description: 'How minds, habits and emotions work, grounded in real research.',
    subject: `The subject is psychology and self-improvement: how minds work, habits, emotions and behaviour.
Ground every claim in research: name the study or researcher when the research gives one, say how strong
the evidence is, and say when findings failed to replicate or are debated. Give practical takeaways as
principles, never as medical or therapeutic advice; for mental-health topics, point viewers to
professional help. Warm and non-judgmental: never mock or diagnose the viewer.`,
    delivery: 'Warm, calm and encouraging; never preachy.',
    theme: 'mind',
    fallbackMood: 'hopeful',
    maxGraphicsShare: 0.5,
    directorNotes: `Use "diagram" for mental models (cycle for habit loops, process for how a bias works), "stat" for a study's striking result, and "comparison" for before vs after. Stock b-roll: human, everyday and calm ("person journaling by window light", "crowded commuter train", "hands holding phone at night"). Never present an illustration as a real brain scan or study image.`,
    illustrations: true,
    captionPreset: 'social_pop',
    suggestedFormats: ['explainer', 'countdown', 'pov', 'story'],
    baseStyle: 'eli5',
  },
];
