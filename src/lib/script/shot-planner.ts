import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider, ProviderCallContext } from '@/pipeline/providers/types';
import type { ResearchFact } from '@/lib/research/types';
import {
  DIAGRAM_LIMITS,
  SHOT_TYPES,
  SIGNATURE_SHOT_TYPES,
  withWritingModel,
  type SignatureShotType,
  type GeneratedScript,
  type ScriptBeat,
  type ShotPlan,
  type ShotType,
} from './generate-script';
import { SPEECH_WORDS_PER_SECOND, STREET_LEVEL_PLACE, estimateSpeechSeconds, toStockQuery } from './script-quality';
import {
  DENSITY_EXEMPT,
  DENSITY_WINDOW,
  MAX_GRAPHICS_SHARE,
  MAX_NON_FOOTAGE_RUN,
  MAX_SAME_TYPE_IN_WINDOW,
  MAX_SAME_TYPE_RUN,
  MAX_TEXT_SHARE,
  analyzeRhythm,
  kindOf,
  planToRhythmShots,
  type RhythmIssue,
  type RhythmRule,
} from './visual-rhythm';
import { stylePack } from '@/lib/styles/packs';

const {
  minSteps: MIN_DIAGRAM_STEPS,
  maxSteps: MAX_DIAGRAM_STEPS,
  secondsPerStep: SECONDS_PER_DIAGRAM_STEP,
  maxLabelWords: MAX_DIAGRAM_LABEL_WORDS,
  maxDetailWords: MAX_DIAGRAM_DETAIL_WORDS,
} = DIAGRAM_LIMITS;

/** Target on-screen time per shot; viewers expect the picture to change every 3-6 seconds. */
const SECONDS_PER_SHOT = 4.5;
const MAX_SHOTS_PER_BEAT = 4;
/** ~2.2s at narration pace; shorter cuts feel choppy on footage. */
const MIN_WORDS_PER_SHOT = 5;
const BEATS_PER_BATCH = 12;
/** Chapter cards mark real turns in the story; closer together they stop meaning anything. */
const MIN_BEATS_BETWEEN_TITLES = 6;
const MAX_TITLE_WORDS = 8;
/** Annotated photos stay special: at least this many shots apart. */
const MIN_SHOTS_BETWEEN_ANNOTATIONS = 3;
const MAX_KINETIC_WORDS = 12;
/** How far an on-screen figure may be from the spoken one (rounding: "about 381" vs 381.17). */
const SPOKEN_FIGURE_TOLERANCE = 0.05;
/** Minimum on-screen seconds for a graphic to be read; a timeline needs this per event. */
const MIN_GRAPHIC_SECONDS: Partial<Record<ShotType, number>> = {
  chart: 3.5,
  comparison: 3,
  quote: 2.5,
  newspaper: 2.5,
  title: 2,
  stat: 2,
  pitch: 4,
  evidence_board: 4,
  letter: 4,
  race_bars: 3.5,
  scale: 4,
  spec_card: 3.5,
  money: 3.5,
};

/** How each signature shot is described to the director, for the styles that use it. */
const SIGNATURE_RULES: Record<SignatureShotType, string> = {
  pitch: `- "pitch": a move or goal recreated on a top-down pitch (the Tifo Football look). pitch = {title, players: [{label, x, y, team: "a"|"b", to: {x, y}}], ball: [{x, y}], outcome: "goal"|"save"|"miss"|null}. x runs 0-100 from the left goal to the right goal, y 0-100 from the top touchline to the bottom one. ball is the ball's path, 2-8 points; players are the few who matter (at most 10), labelled with surnames from the narration or research, or shirt numbers; to is where a player runs. For a specific goal, chance or tactical idea the narration describes, not general match talk.`,
  evidence_board: `- "evidence_board": the investigation as pinned clues joined by red string; the camera moves clue to clue. evidence = {title, items: [{kind: "photo"|"note"|"clipping"|"place", label, detail}], links: [[i, j]]}. 3-6 items: photo for a person, note for a fact or question, clipping for a report, place for a location; label at most 5 words, detail at most 8, all stated in the narration or research. links join items the story connects (indexes into items). For moments that tie the case's threads together.`,
  letter: `- "letter": a historical letter or telegram, its words inking in by hand. letter = {writer, recipient, date, text}. text must be words the narration or research quotes from it, exactly; writer and recipient as named there.`,
  race_bars: `- "race_bars": figures racing as bars, the winner lit. race = {title, unit, lower_is_better, items: [{label, value}]}. For times (0-60 mph in seconds, lap times) set lower_is_better true; for scores or speeds false. 2-6 items; every value stated in the narration or research.`,
  spec_card: `- "spec_card": a spec sheet for one car or product. spec = {title, subject, rows: [{label, value}]}. title is its name, subject a short kicker such as the maker and year; 3-6 rows like {label: "0-60 mph", value: "2.1 s"}. Every figure stated in the narration or research.`,
  money: `- "money": money you can see. money = {kind: "growth"|"shrink", from, to, currency, label}. growth: notes piling up as a sum compounds (from the starting amount to the end amount); shrink: one note shrinking to what it's worth after inflation. currency is the symbol, e.g. "$"; label says what it shows, e.g. "$1,000 at 10% for 36 years". from and to must be stated in the narration or research.`,
  scale: `- "scale": things shown side by side at true relative size, the camera pulling back as each bigger one arrives. scale = {title, items: [{label, size, unit}]}. 2-5 items in the same unit (e.g. diameters in km); every size stated in the narration or research.`,
};

export interface SignatureOptions {
  /** Signature shot types this style may use. */
  signature?: readonly SignatureShotType[];
  /** Charts may carry callouts. */
  chartCallouts?: boolean;
}

const MAX_CALLOUTS = 2;
const MAX_CALLOUT_WORDS = 6;
const SECONDS_PER_TIMELINE_EVENT = 1.6;

export function shotCountForBeat(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const bySeconds = Math.round(estimateSpeechSeconds(text) / SECONDS_PER_SHOT);
  const byWords = Math.floor(words / MIN_WORDS_PER_SHOT);
  return Math.max(1, Math.min(MAX_SHOTS_PER_BEAT, bySeconds, byWords));
}

// --------------------------------------------------------------------------
// Director prompt and response schema
// --------------------------------------------------------------------------

const DIRECTOR_SYSTEM = `You are the visual director of a premium documentary YouTube channel (think Vox, Johnny Harris, ColdFusion). For each narration beat you plan the shots the viewer sees.

SHOTS
- Each beat states how many shots it needs. Split its narration into exactly that many consecutive parts at natural phrase boundaries (a diagram may stand in for several, see below). "covers" is the exact words of that part, in order; together the parts cover the whole beat.
- Cut on meaning: the chart appears on the words that state the number, the map when the places are named, the quote card when the quote is spoken.

SHOT TYPES (fill the matching spec object; leave the others out)
- "stock": cinematic b-roll. visual_query: 3-6 concrete filmable nouns plus mood or era, e.g. "rain on empty city street, 1930s".
- "archive": real historical photos or film from public archives. visual_query: searchable nouns plus year, e.g. "1929 crowd outside New York Stock Exchange".
- "chart": data over time or a comparison. chart = {chart_type: "line"|"bar"|"pie", title, unit, labels, values}. Needs at least 2 values; labels and values have the same length.
- "stat": one striking number as a full-screen animated figure. stat = {value, prefix, suffix, label}, e.g. {value: 14, prefix: "$", suffix: " billion", label: "lost on Black Tuesday"}.
- "quote": a pull-quote card. quote = {text, attribution}. Only words the narration or the research actually attributes to that person.
- "geo_map": places at city, country, or continent scale. map = {places: [...], mode: "route"|"spread"|"locate"}. Never streets or buildings.
- "newspaper": a real front page. newspaper = {outlet, date, headline}. Only headlines quoted in the research facts.
- "screen_recording": a named website or app shown live. visual_query: its URL.
- "timeline": 2-6 dated events in order. timeline = {events: [{date, label}]}, e.g. {date: "Oct 24", label: "Black Thursday"}. Only dates stated in the narration or research.
- "comparison": two figures side by side. comparison = {title, left: {value, label}, right: {value, label}}, e.g. left {value: "3%", label: "unemployed in 1929"}. Values must be stated in the narration or research.
- "title": a chapter card where the story turns to a new part. title_card = {text, kicker}; text at most ${MAX_TITLE_WORDS} words, kicker a short label like "Part two". Use rarely: at most once every ${MIN_BEATS_BETWEEN_TITLES} beats.
- "kinetic_text": the narrator's own words set as bold animated type, for the single most important line of a passage. kinetic = {phrase, emphasis}; phrase is copied exactly from the shot's narration, at most ${MAX_KINETIC_WORDS} words; emphasis is 1-3 key words from it.
- "diagram": how something works, step by step. diagram = {kind: "process"|"cycle"|"breakdown", title, center, steps: [{label, detail}]}. process = steps in order ("Ship enters the lock" -> "Gates close" -> "Lake water flows in" -> "Ship rises"); cycle = steps that repeat in a loop; breakdown = the parts of one thing, with center naming it. ${MIN_DIAGRAM_STEPS}-${MAX_DIAGRAM_STEPS} steps; label at most 5 words, detail at most 10; each step restates what the narration explains, in the order it says it. Needs about ${Math.round(SECONDS_PER_DIAGRAM_STEP * 2.3)} words of narration per step. Use for mechanisms and processes the viewer must understand, not for lists of facts. A diagram may take the place of up to 3 of the beat's shots: return fewer shots, with the diagram's covers spanning the whole passage it explains, so every step gets its own words.
- Footage of a specific named person or place may carry caption = {name, detail}, a lower-third such as {name: "Herbert Hoover", detail: "U.S. President, 1929-33"}. Only names and details stated in the narration or research.
- An archive or stock PHOTO where one part matters may carry annotation = {target, label, detail} instead of a caption: the camera pushes in, circles that part and labels it (the Vox look). target says what to find in the photo, e.g. "the lock gates" or "the man in the top hat"; label names it, e.g. "Gatun Locks"; detail is optional, e.g. "opened 1914". Best for structures, sites, machines, and one key person in a group. Label and detail must be stated in the narration or research. Use sparingly: at most one in every ${MIN_SHOTS_BETWEEN_ANNOTATIONS} shots.

DATA INTEGRITY
- Every value in a chart or stat must be a number stated in the beat's narration or its research facts. Never estimate, interpolate, or invent data points. If you only have one number, use "stat", not "chart".
- A stat or comparison shows the figure the narration speaks in that beat, never a different figure from the research.
- Give graphics time to be read: a chart needs about 8 words of narration, a timeline about 4 words per event.
- Set fact_ids on each shot to the research facts it shows.

RHYTHM AND VARIETY
- Alternate footage (stock/archive) with graphics; a graphic lands harder with footage around it.
- Never more than 2 graphics of the same type in a row, across beat boundaries too.
- Never repeat a search phrase; neighbouring footage shots should show different things.`;

const nullableObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).nullable().optional();

const DirectorShotSchema = z.object({
  visual_type: z.enum(SHOT_TYPES),
  covers: z.string(),
  visual_query: z.string(),
  fact_ids: z.array(z.string()).nullable().optional(),
  chart: nullableObject({
    chart_type: z.enum(['line', 'bar', 'pie']),
    title: z.string(),
    unit: z.string().nullable().optional(),
    labels: z.array(z.string()),
    values: z.array(z.number()),
    annotations: z.array(z.object({ index: z.number(), text: z.string() })).nullable().optional(),
  }),
  stat: nullableObject({
    value: z.number(),
    prefix: z.string().nullable().optional(),
    suffix: z.string().nullable().optional(),
    label: z.string(),
  }),
  quote: nullableObject({ text: z.string(), attribution: z.string() }),
  map: nullableObject({ places: z.array(z.string()), mode: z.enum(['route', 'spread', 'locate']) }),
  newspaper: nullableObject({ outlet: z.string(), date: z.string(), headline: z.string() }),
  timeline: nullableObject({ events: z.array(z.object({ date: z.string(), label: z.string() })) }),
  comparison: nullableObject({
    title: z.string().nullable().optional(),
    left: z.object({ value: z.string(), label: z.string() }),
    right: z.object({ value: z.string(), label: z.string() }),
  }),
  title_card: nullableObject({ text: z.string(), kicker: z.string().nullable().optional() }),
  kinetic: nullableObject({ phrase: z.string(), emphasis: z.array(z.string()) }),
  pitch: nullableObject({
    title: z.string().nullable().optional(),
    players: z.array(
      z.object({
        label: z.string(),
        x: z.number(),
        y: z.number(),
        team: z.enum(['a', 'b']),
        to: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
      }),
    ),
    ball: z.array(z.object({ x: z.number(), y: z.number() })),
    outcome: z.enum(['goal', 'save', 'miss']).nullable().optional(),
  }),
  evidence: nullableObject({
    title: z.string().nullable().optional(),
    items: z.array(z.object({ kind: z.enum(['photo', 'note', 'clipping', 'place']), label: z.string(), detail: z.string().nullable().optional() })),
    links: z.array(z.array(z.number())),
  }),
  letter: nullableObject({
    writer: z.string(),
    recipient: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    text: z.string(),
  }),
  race: nullableObject({
    title: z.string(),
    unit: z.string().nullable().optional(),
    lower_is_better: z.boolean(),
    items: z.array(z.object({ label: z.string(), value: z.number() })),
  }),
  scale: nullableObject({
    title: z.string().nullable().optional(),
    items: z.array(z.object({ label: z.string(), size: z.number(), unit: z.string() })),
  }),
  spec: nullableObject({
    title: z.string(),
    subject: z.string().nullable().optional(),
    rows: z.array(z.object({ label: z.string(), value: z.string() })),
  }),
  money: nullableObject({
    kind: z.enum(['growth', 'shrink']),
    from: z.number(),
    to: z.number(),
    currency: z.string(),
    label: z.string(),
  }),
  caption: nullableObject({ name: z.string(), detail: z.string().nullable().optional() }),
  annotation: nullableObject({ target: z.string(), label: z.string(), detail: z.string().nullable().optional() }),
  diagram: nullableObject({
    kind: z.enum(['process', 'cycle', 'breakdown']),
    title: z.string().nullable().optional(),
    center: z.string().nullable().optional(),
    steps: z.array(z.object({ label: z.string(), detail: z.string().nullable().optional() })),
  }),
});

export const DirectorResponseSchema = z.object({
  beats: z.array(z.object({ index: z.number(), shots: z.array(DirectorShotSchema) })),
});

type DirectorShot = z.infer<typeof DirectorShotSchema>;

function buildBatchPrompt(
  topic: string,
  beats: ScriptBeat[],
  facts: ResearchFact[],
  previousShotTypes: ShotType[],
  styleNotes?: string,
  signature: SignatureOptions = {},
): string {
  const factSection = facts.length
    ? `RESEARCH FACTS:\n${facts.map((f) => `${f.id}: ${f.claim}`).join('\n')}\n\n`
    : '';
  const continuity = previousShotTypes.length
    ? `The shots just before this batch were: ${previousShotTypes.join(', ')}. Keep the variety rule across that boundary.\n\n`
    : '';
  const beatLines = beats
    .map(
      (b) =>
        `Beat ${b.index} (needs ${shotCountForBeat(b.text)} shot${shotCountForBeat(b.text) === 1 ? '' : 's'}; writer suggested ${b.visual_type}: "${b.visual_query}"${b.fact_ids?.length ? `; facts ${b.fact_ids.join(', ')}` : ''}):\n${b.text}`,
    )
    .join('\n\n');

  const signatureRules = [
    ...(signature.signature ?? []).map((t) => SIGNATURE_RULES[t]),
    ...(signature.chartCallouts
      ? [`- A "chart" may carry annotations = [{index, text}]: up to ${MAX_CALLOUTS} callouts on the points or bars that matter ("the crash", "peak"), index into its values, text at most ${MAX_CALLOUT_WORDS} words.`]
      : []),
  ];
  const signatureSection = signatureRules.length
    ? `SIGNATURE SHOTS FOR THIS STYLE (use where they fit the narration, a few per video, never in a row):\n${signatureRules.join('\n')}\n\n`
    : '';
  return `Video topic: "${topic}"

${styleNotes ? `STYLE NOTES (this kind of video):
${styleNotes}

` : ''}${signatureSection}${factSection}${continuity}Plan the shots for these beats. Return {"beats": [{"index": ..., "shots": [...]}]} with one entry per beat.

${beatLines}`;
}

// --------------------------------------------------------------------------
// Deterministic validation and repair
// --------------------------------------------------------------------------

const normalizeWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const normalizeText = (s: string) => s.split(/\s+/).map(normalizeWord).filter(Boolean).join(' ');

const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Spelled-out numbers up to the hundreds, e.g. "twenty-five", "three hundred eighty-one". */
function spelledNumbers(text: string): Array<{ value: number; scale?: number }> {
  const out: Array<{ value: number; scale?: number }> = [];
  const tokens = text.toLowerCase().replace(/-/g, ' ').split(/[^a-z]+/).filter(Boolean);
  let current: number | null = null;
  const flush = (scale?: number) => {
    if (current !== null) out.push({ value: current, scale });
    current = null;
  };
  for (const t of tokens) {
    if (t in UNITS) current = (current ?? 0) + UNITS[t];
    else if (t in TENS) current = (current ?? 0) + TENS[t];
    else if (t === 'hundred' && current !== null) current *= 100;
    else if (t in SCALES && current !== null) flush(SCALES[t]);
    else if (t !== 'and') flush();
  }
  flush();
  return out;
}

/** Every number stated in the text, also at its full scale ("$14 billion" -> 14 and 14e9). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(thousand|million|billion|trillion)?/gi;
  for (const m of text.matchAll(re)) {
    const base = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    out.push(base);
    const scale = m[2] ? SCALES[m[2].toLowerCase()] : undefined;
    if (scale) out.push(base * scale);
  }
  for (const { value, scale } of spelledNumbers(text)) {
    out.push(value);
    if (scale) out.push(value * scale);
  }
  return out;
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE_PARTS = new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}|\\b(?:1[0-9]{3}|20[0-9]{2})\\b`, 'gi');

/** Numbers stated as quantities: like numbersIn, but ignoring days of the month and years. */
export function quantitiesIn(text: string): number[] {
  return numbersIn(text.replace(DATE_PARTS, ' '));
}

/**
 * The part of a proposed quotation that the narration or research actually presents as a
 * quotation (inside quotation marks). Returns '' when nothing is quoted, so a narrator's own
 * line can never be dressed up as someone's quote.
 */
export function quotedPassageFor(quote: string, ground: string): string {
  const quoteNorm = ` ${normalizeText(quote)} `;
  const passages = [...ground.matchAll(/["“]([^"”]{3,})["”]/g)]
    .map((m) => m[1].trim().replace(/[.,;:!?]+$/, ''))
    .filter((p) => p.split(/\s+/).length >= 3);

  // A quoted passage contained in the proposal, or a proposal contained in a quoted passage
  const matches = passages
    .map((p) => {
      const pNorm = ` ${normalizeText(p)} `;
      if (quoteNorm.includes(pNorm)) return p;
      if (pNorm.includes(quoteNorm)) return quote.trim().replace(/^["“'‘]+|["”'’.,;:!?]+$/g, '');
      return '';
    })
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return matches[0] ?? '';
}

const isStated = (value: number, pool: number[]) =>
  pool.some((n) => Math.abs(n - value) <= Math.max(1e-9, Math.abs(n) * 0.005));

/**
 * Assigns each shot a contiguous word range of the beat. Uses the director's "covers" text
 * to find where each shot starts; if that can't be matched in order, splits the beat evenly
 * at the nearest punctuation instead. Shots shorter than MIN_WORDS_PER_SHOT are merged away.
 */
export function alignShotsToNarration<T extends { covers: string }>(
  beatText: string,
  shots: T[],
): Array<T & { word_start: number; word_count: number }> {
  const words = beatText.trim().split(/\s+/).filter(Boolean);
  const norm = words.map(normalizeWord);
  if (shots.length === 0 || words.length === 0) return [];

  const findStart = (covers: string, from: number): number => {
    const probe = covers.split(/\s+/).map(normalizeWord).filter(Boolean).slice(0, 3);
    if (probe.length === 0) return -1;
    for (let i = from; i <= norm.length - probe.length; i++) {
      if (probe.every((p, k) => norm[i + k] === p)) return i;
    }
    return -1;
  };

  let starts: number[] = [0];
  let cursor = 1;
  let matched = true;
  for (let s = 1; s < shots.length; s++) {
    const at = findStart(shots[s].covers, cursor);
    if (at < 0) {
      matched = false;
      break;
    }
    starts.push(at);
    cursor = at + 1;
  }

  if (!matched) {
    // Even split, nudged to the nearest phrase boundary (word ending in punctuation)
    starts = [0];
    for (let s = 1; s < shots.length; s++) {
      const ideal = Math.round((s * words.length) / shots.length);
      let best = ideal;
      for (let d = 0; d <= 3; d++) {
        if (/[,.;:!?—-]$/.test(words[ideal - d - 1] ?? '')) {
          best = ideal - d;
          break;
        }
        if (/[,.;:!?—-]$/.test(words[ideal + d - 1] ?? '')) {
          best = ideal + d;
          break;
        }
      }
      starts.push(Math.min(Math.max(best, starts[s - 1] + 1), words.length - 1));
    }
  }

  const ranged = shots.map((shot, i) => {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : words.length;
    return { ...shot, word_start: start, word_count: end - start };
  });

  // Merge too-short shots into the previous one (or the next, for the first)
  const merged: Array<T & { word_start: number; word_count: number }> = [];
  for (const shot of ranged) {
    if (shot.word_count >= MIN_WORDS_PER_SHOT || merged.length === 0) {
      merged.push(shot);
    } else {
      merged[merged.length - 1].word_count += shot.word_count;
    }
  }
  if (merged.length > 1 && merged[0].word_count < MIN_WORDS_PER_SHOT) {
    merged[1] = { ...merged[1], word_start: 0, word_count: merged[1].word_count + merged[0].word_count };
    merged.shift();
  }

  return merged.map((shot) => ({
    ...shot,
    covers: words.slice(shot.word_start, shot.word_start + shot.word_count).join(' '),
  }));
}

function footageFallback(beat: ScriptBeat, shot: DirectorShot): DirectorShot {
  return {
    covers: shot.covers,
    visual_type: beat.visual_type === 'archive' ? 'archive' : 'stock',
    visual_query: toStockQuery(shot.visual_query) || beat.visual_query,
    fact_ids: shot.fact_ids,
  };
}

/**
 * Keeps a graphic shot only if its data is grounded: chart/stat values must be stated in the
 * narration or cited facts, quotes must appear verbatim, headlines must be quoted in the
 * research, and map places must be named at city scale or larger. Anything else becomes footage.
 */
export function verifyShot(shot: DirectorShot, beat: ScriptBeat, facts: ResearchFact[]): DirectorShot {
  const factIds = new Set([...(beat.fact_ids ?? []), ...(shot.fact_ids ?? [])]);
  const citedFacts = facts.filter((f) => factIds.has(f.id));
  const groundText = [beat.text, ...citedFacts.map((f) => f.claim)].join(' ');
  const numberPool = numbersIn(groundText);
  const groundNorm = normalizeText(groundText);
  const anyFactNorm = normalizeText(facts.map((f) => f.claim).join(' '));

  /**
   * A value is grounded if the narration or a cited fact states it. Failing that, any research
   * fact stating it grounds it too, and that fact is recorded on the shot as its source.
   */
  const groundValues = (values: number[]): string[] | null => {
    const extraFacts: string[] = [];
    for (const v of values) {
      if (isStated(v, numberPool)) continue;
      // Dates and years in unrelated facts must not ground a figure ("Oct 30" is not "$30 billion")
      const source = facts.find((f) => isStated(v, quantitiesIn(f.claim)));
      if (!source) return null;
      if (!extraFacts.includes(source.id)) extraFacts.push(source.id);
    }
    return extraFacts;
  };
  const withFacts = (extra: string[]): DirectorShot =>
    extra.length ? { ...shot, fact_ids: [...new Set([...(shot.fact_ids ?? []), ...extra])] } : shot;
  /** Text named in the narration, a cited fact, or any research fact (whole words only). */
  const isNamed = (s: string) => {
    const n = normalizeText(s);
    return Boolean(n) && (` ${groundNorm} `.includes(` ${n} `) || ` ${anyFactNorm} `.includes(` ${n} `));
  };
  // Close to a number the beat's narration states: "sixteen million" covers 16.4M on screen
  const spokenPool = numbersIn(beat.text);
  const isSpokenFigure = (value: number) =>
    spokenPool.some((n) => Math.abs(n - Math.abs(value)) <= Math.max(1e-9, Math.abs(n) * SPOKEN_FIGURE_TOLERANCE));
  // Dates are grounded by their exact day and year numbers (no rounding tolerance: 1925 is not
  // 1929); month names may be abbreviated, so they aren't compared
  const datePool = new Set(numbersIn([groundText, ...facts.map((f) => f.claim)].join(' ')));
  const isStatedDate = (date: string) => {
    const nums = numbersIn(date);
    return nums.length ? nums.every((v) => datePool.has(v)) : isNamed(date);
  };

  const wordsIn = (s?: string | null) => (s ?? '').trim().split(/\s+/).filter(Boolean).length;
  const figuresGrounded = (s?: string | null) => !s || groundValues(quantitiesIn(s)) !== null;
  /** Shares a content word with the narration or research (loosely: "murdered" ~ "murder"). */
  const relatesToGround = (s: string) => {
    const pool = new Set(`${groundNorm} ${anyFactNorm}`.split(' ').filter((w) => w.length > 3));
    return normalizeText(s)
      .split(' ')
      .filter((w) => w.length > 3)
      .some((w) => pool.has(w) || [...pool].some((g) => g.length >= 5 && w.length >= 5 && g.slice(0, 5) === w.slice(0, 5)));
  };
  const inPitch = (p: { x: number; y: number }) => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100;

  switch (shot.visual_type) {
    case 'pitch': {
      const spec = shot.pitch;
      if (!spec) return footageFallback(beat, shot);
      const ball = spec.ball.filter(inPitch).slice(0, 8);
      // Names on the pitch must be in the story; shirt numbers and initials are just markers
      const labelOk = (l: string) => l.trim() && (/^\d{1,2}$/.test(l.trim()) || /^[A-Z]{1,3}$/.test(l.trim()) || (wordsIn(l) <= 3 && isNamed(l)));
      const players = spec.players
        .filter((p) => inPitch(p) && (!p.to || inPitch(p.to)) && labelOk(p.label))
        .slice(0, 10)
        .map((p) => ({ ...p, label: p.label.trim(), to: p.to ?? null }));
      if (ball.length < 2) return footageFallback(beat, shot);
      const title = spec.title?.trim() && wordsIn(spec.title) <= MAX_TITLE_WORDS && figuresGrounded(spec.title) ? spec.title.trim() : null;
      return { ...shot, pitch: { title, players, ball, outcome: spec.outcome ?? null } };
    }
    case 'evidence_board': {
      const spec = shot.evidence;
      if (!spec) return footageFallback(beat, shot);
      const items = spec.items
        .map((it) => ({ kind: it.kind, label: it.label.trim(), detail: it.detail?.trim() || null }))
        .filter((it) => it.label && wordsIn(it.label) <= 5 && (isNamed(it.label) || relatesToGround(it.label)) && figuresGrounded(it.label))
        .map((it) => ({ ...it, detail: it.detail && wordsIn(it.detail) <= 8 && figuresGrounded(it.detail) ? it.detail : null }))
        .slice(0, 6);
      if (items.length < 3) return footageFallback(beat, shot);
      const seen = new Set<string>();
      const links = spec.links
        .filter((l) => l.length === 2 && l.every((i) => Number.isInteger(i) && i >= 0 && i < items.length) && l[0] !== l[1])
        .filter(([a, b]) => {
          const key = [a, b].sort().join('-');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 8);
      const title = spec.title?.trim() && wordsIn(spec.title) <= MAX_TITLE_WORDS && figuresGrounded(spec.title) ? spec.title.trim() : null;
      return { ...shot, evidence: { title, items, links } };
    }
    case 'letter': {
      const spec = shot.letter;
      if (!spec || !isNamed(spec.writer.trim())) return footageFallback(beat, shot);
      // Only words the narration or research quotes, as with a quote card
      const text = quotedPassageFor(spec.text, `${groundText} ${facts.map((f) => f.claim).join(' ')}`);
      if (wordsIn(text) < 5) return footageFallback(beat, shot);
      const recipient = spec.recipient?.trim() && isNamed(spec.recipient.trim()) ? spec.recipient.trim() : null;
      const date = spec.date?.trim() && isStatedDate(spec.date.trim()) ? spec.date.trim() : null;
      return { ...shot, letter: { writer: spec.writer.trim(), recipient, date, text } };
    }
    case 'race_bars': {
      const spec = shot.race;
      if (!spec) return footageFallback(beat, shot);
      const items = spec.items
        .map((it) => ({ label: it.label.trim(), value: it.value }))
        .filter((it) => it.label && wordsIn(it.label) <= 4 && Number.isFinite(it.value) && it.value > 0)
        .slice(0, 6);
      const extra = items.length >= 2 ? groundValues(items.map((it) => it.value)) : null;
      if (!extra || !spec.title.trim() || wordsIn(spec.title) > MAX_TITLE_WORDS) return footageFallback(beat, shot);
      return { ...withFacts(extra), race: { title: spec.title.trim(), unit: spec.unit?.trim() || null, lower_is_better: spec.lower_is_better, items } };
    }
    case 'scale': {
      const spec = shot.scale;
      if (!spec) return footageFallback(beat, shot);
      const items = spec.items
        .map((it) => ({ label: it.label.trim(), size: it.size, unit: it.unit.trim() }))
        .filter((it) => it.label && wordsIn(it.label) <= 4 && (isNamed(it.label) || relatesToGround(it.label)) && it.size > 0)
        .slice(0, 5);
      const units = new Set(items.map((it) => it.unit.toLowerCase()));
      const extra = items.length >= 2 && units.size === 1 ? groundValues(items.map((it) => it.size)) : null;
      if (!extra) return footageFallback(beat, shot);
      const title = spec.title?.trim() && wordsIn(spec.title) <= MAX_TITLE_WORDS && figuresGrounded(spec.title) ? spec.title.trim() : null;
      return { ...withFacts(extra), scale: { title, items } };
    }
    case 'spec_card': {
      const spec = shot.spec;
      if (!spec?.title.trim() || wordsIn(spec.title) > 6) return footageFallback(beat, shot);
      // Every figure in a row must be stated; a row without figures must still relate to the story
      const rows = spec.rows
        .map((r) => ({ label: r.label.trim(), value: r.value.trim() }))
        .filter((r) => r.label && r.value && wordsIn(r.label) <= 4 && wordsIn(r.value) <= 4 && figuresGrounded(r.value) && (quantitiesIn(r.value).length > 0 || relatesToGround(r.value)))
        .slice(0, 6);
      if (rows.length < 3 || !(isNamed(spec.title.trim()) || relatesToGround(spec.title))) return footageFallback(beat, shot);
      const subject = spec.subject?.trim() && wordsIn(spec.subject) <= 5 && figuresGrounded(spec.subject) ? spec.subject.trim() : null;
      return { ...shot, spec: { title: spec.title.trim(), subject, rows } };
    }
    case 'money': {
      const spec = shot.money;
      if (!spec || !(spec.from > 0) || !(spec.to > 0) || spec.from === spec.to) return footageFallback(beat, shot);
      if ((spec.kind === 'growth') !== spec.to > spec.from) return footageFallback(beat, shot);
      const extra = groundValues([spec.from, spec.to]);
      const label = spec.label.trim();
      if (!extra || !label || wordsIn(label) > 10 || !figuresGrounded(label)) return footageFallback(beat, shot);
      const currency = spec.currency.trim().slice(0, 3) || '$';
      return { ...withFacts(extra), money: { kind: spec.kind, from: spec.from, to: spec.to, currency, label } };
    }
    case 'stock':
    case 'archive': {
      const detailOf = (raw?: string | null) => {
        const detail = raw?.trim();
        return detail && groundValues(quantitiesIn(detail)) !== null && detail.split(/\s+/).length <= 8 ? detail : null;
      };
      let checked: DirectorShot = shot;
      if (shot.caption) {
        // A caption naming someone the narration never names would be an unchecked claim
        const name = shot.caption.name.trim();
        checked = name && isNamed(name) ? { ...checked, caption: { name, detail: detailOf(shot.caption.detail) } } : { ...checked, caption: null };
      }
      if (shot.annotation) {
        // Same rule for the label; the target is only an instruction to the vision model
        const label = shot.annotation.label.trim();
        const target = shot.annotation.target.trim();
        const ok = label && isNamed(label) && label.split(/\s+/).length <= 6 && target && target.split(/\s+/).length <= 10;
        checked = ok
          ? { ...checked, annotation: { target, label, detail: detailOf(shot.annotation.detail) } }
          : { ...checked, annotation: null };
      }
      return checked;
    }
    case 'diagram': {
      const spec = shot.diagram;
      if (!spec) return footageFallback(beat, shot);
      const wordCount = (s?: string | null) => (s ?? '').trim().split(/\s+/).filter(Boolean).length;
      // A step must restate what the narration (or its research) explains: it shares a content
      // word with it, loosely ("gates close" ~ "the gates shut", "fills" ~ "filling")
      const groundWords = new Set(groundNorm.split(' ').filter((w) => w.length > 3));
      const relates = (s: string) =>
        normalizeText(s)
          .split(' ')
          .filter((w) => w.length > 3)
          .some((w) => groundWords.has(w) || [...groundWords].some((g) => g.slice(0, 5) === w.slice(0, 5) && w.length >= 5));
      const figuresOk = (s?: string | null) => !s || groundValues(quantitiesIn(s)) !== null;
      const steps = spec.steps
        .map((s) => ({ label: s.label.trim(), detail: s.detail?.trim() || null }))
        .filter((s) => s.label && wordCount(s.label) <= MAX_DIAGRAM_LABEL_WORDS && relates(s.label) && figuresOk(s.label))
        .map((s) => ({ label: s.label, detail: s.detail && wordCount(s.detail) <= MAX_DIAGRAM_DETAIL_WORDS && figuresOk(s.detail) ? s.detail : null }))
        .slice(0, MAX_DIAGRAM_STEPS);
      const center = spec.center?.trim() || null;
      const title = spec.title?.trim() && wordCount(spec.title) <= MAX_TITLE_WORDS && figuresOk(spec.title) ? spec.title.trim() : null;
      if (steps.length < MIN_DIAGRAM_STEPS) return footageFallback(beat, shot);
      if (spec.kind === 'breakdown' && !(center && wordCount(center) <= MAX_DIAGRAM_LABEL_WORDS && relates(center))) {
        return footageFallback(beat, shot);
      }
      return { ...shot, diagram: { kind: spec.kind, title, center: spec.kind === 'breakdown' ? center : null, steps } };
    }
    case 'timeline': {
      const events = (shot.timeline?.events ?? [])
        .map((e) => ({ date: e.date.trim(), label: e.label.trim() }))
        .filter((e) => e.date && e.label && isStatedDate(e.date) && groundValues(quantitiesIn(e.label)) !== null)
        .slice(0, 6);
      return events.length >= 2 ? { ...shot, timeline: { events } } : footageFallback(beat, shot);
    }
    case 'comparison': {
      const cmp = shot.comparison;
      if (!cmp) return footageFallback(beat, shot);
      const sideOk = (side: { value: string; label: string }) => {
        const nums = numbersIn(side.value);
        return (
          side.value.trim() &&
          side.label.trim() &&
          (nums.length ? nums.some(isSpokenFigure) && groundValues(nums) !== null : isNamed(side.value))
        );
      };
      if (!sideOk(cmp.left) || !sideOk(cmp.right)) return footageFallback(beat, shot);
      const extra = [...(groundValues(numbersIn(cmp.left.value)) ?? []), ...(groundValues(numbersIn(cmp.right.value)) ?? [])];
      return withFacts(extra);
    }
    case 'title': {
      const text = shot.title_card?.text.trim() ?? '';
      if (!text || text.split(/\s+/).length > MAX_TITLE_WORDS) return footageFallback(beat, shot);
      const kicker = shot.title_card?.kicker?.trim();
      return { ...shot, title_card: { text, kicker: kicker && kicker.split(/\s+/).length <= 4 ? kicker : null } };
    }
    case 'kinetic_text': {
      // Only the narrator's own words, so the type always matches what is heard
      const spoken = ` ${normalizeText(beat.text)} `;
      let phrase = shot.kinetic?.phrase.trim().replace(/^["“'‘]+|["”'’]+$/g, '') ?? '';
      if (!phrase || !spoken.includes(` ${normalizeText(phrase)} `)) phrase = shot.covers.trim();
      if (!phrase || phrase.split(/\s+/).length > MAX_KINETIC_WORDS || !spoken.includes(` ${normalizeText(phrase)} `)) {
        return footageFallback(beat, shot);
      }
      const phraseWords = new Set(phrase.split(/\s+/).map(normalizeWord));
      const emphasis = (shot.kinetic?.emphasis ?? []).filter((w) => phraseWords.has(normalizeWord(w))).slice(0, 3);
      return { ...shot, kinetic: { phrase, emphasis } };
    }
    case 'chart': {
      const chart = shot.chart;
      if (!chart) return footageFallback(beat, shot);
      const n = Math.min(chart.labels.length, chart.values.length);
      const labels = chart.labels.slice(0, n);
      const values = chart.values.slice(0, n);
      const extra = n >= 2 ? groundValues(values) : null;
      if (!extra) return footageFallback(beat, shot);
      const annotations = (chart.annotations ?? [])
        .map((a) => ({ index: a.index, text: a.text.trim() }))
        .filter((a) => Number.isInteger(a.index) && a.index >= 0 && a.index < n && a.text && wordsIn(a.text) <= MAX_CALLOUT_WORDS && figuresGrounded(a.text))
        .slice(0, MAX_CALLOUTS);
      return { ...withFacts(extra), chart: { ...chart, labels, values, annotations: annotations.length ? annotations : null } };
    }
    case 'stat': {
      // A lone figure must be the one being spoken: a true but different number on screen
      // ("$14 billion" while the narrator says "thirty billion") reads as a contradiction
      const extra = shot.stat && isSpokenFigure(shot.stat.value) ? groundValues([shot.stat.value]) : null;
      return extra ? withFacts(extra) : footageFallback(beat, shot);
    }
    case 'quote': {
      if (!shot.quote) return footageFallback(beat, shot);
      // Only words the narration or research presents in quotation marks can go on a quote card
      const passage = quotedPassageFor(shot.quote.text, `${groundText} ${facts.map((f) => f.claim).join(' ')}`);
      return passage.split(/\s+/).length >= 3
        ? { ...shot, quote: { ...shot.quote, text: passage } }
        : footageFallback(beat, shot);
    }
    case 'newspaper': {
      const paper = shot.newspaper;
      const headline = paper ? normalizeText(paper.headline) : '';
      const quotedInResearch = facts.some(
        (f) => /["“]/.test(f.claim) && normalizeText(f.claim).includes(headline),
      );
      // The narration itself naming the outlet and quoting the headline also grounds it
      const quotedInNarration =
        /["“]/.test(beat.text) &&
        normalizeText(beat.text).includes(headline) &&
        normalizeText(beat.text).includes(normalizeText(paper?.outlet ?? ''));
      return headline && (quotedInResearch || quotedInNarration) ? shot : footageFallback(beat, shot);
    }
    case 'geo_map': {
      const places = (shot.map?.places ?? []).filter(
        (p) => p.trim() && !STREET_LEVEL_PLACE.test(p) && (groundNorm.includes(normalizeText(p)) || anyFactNorm.includes(normalizeText(p))),
      );
      const needed = shot.map?.mode === 'locate' ? 1 : 2;
      return shot.map && places.length >= needed ? { ...shot, map: { ...shot.map, places } } : footageFallback(beat, shot);
    }
    default:
      return shot;
  }
}

/** When a plan has too many graphics, the lowest of these become footage first. */
const GRAPHIC_KEEP_PRIORITY: Partial<Record<ShotType, number>> = {
  kinetic_text: 0,
  stat: 1,
  comparison: 2,
  quote: 3,
  timeline: 4,
  chart: 5,
  title: 6,
  diagram: 6,
  newspaper: 7,
  geo_map: 8,
  race_bars: 8,
  scale: 9,
  letter: 9,
  evidence_board: 9,
  pitch: 9,
  spec_card: 8,
  money: 8,
};
/** Share-of-video rules need enough shots to mean anything. */
const MIN_SHOTS_FOR_SHARE_RULES = 8;

/** Number of trailing items matching `test`. */
const trailing = <T>(items: T[], test: (item: T) => boolean) => {
  let n = 0;
  for (let i = items.length - 1; i >= 0 && test(items[i]); i--) n++;
  return n;
};

/**
 * Repairs the plan's visual rhythm across beats (see visual-rhythm.ts), turning the offending
 * graphic into footage: a third graphic or text card in a row, a third of one type in a row, a
 * type crowding one stretch, a chapter card too soon after the last, kinetic text beyond its
 * share, and finally graphics beyond their share of screen time (least essential first).
 * Returns the repaired beats and what was changed.
 */
export function repairRhythm(
  beats: ScriptBeat[],
  maxGraphicsShare: number = MAX_GRAPHICS_SHARE,
): { beats: ScriptBeat[]; fixes: RhythmIssue[] } {
  const fixes: RhythmIssue[] = [];
  const totalShots = beats.reduce((n, b) => n + (b.shots?.length ?? 0), 0);
  const shareRules = totalShots >= MIN_SHOTS_FOR_SHARE_RULES;
  const allowedText = Math.max(1, Math.floor(totalShots * MAX_TEXT_SHARE));
  const recent: ShotType[] = [];
  let textCount = 0;
  let lastTitleBeat = -Infinity;
  let lastAnnotated = -Infinity;

  const sequenced = beats.map((beat) => ({
    ...beat,
    shots: beat.shots?.map((shot, i) => {
      const type = shot.visual_type;
      const kind = kindOf(type);
      let problem: [RhythmRule, string] | null = null;
      if (kind !== 'footage') {
        const where = `Beat ${beat.index + 1}, shot ${i + 1}`;
        const inWindow = recent.slice(-(DENSITY_WINDOW - 1)).filter((t) => t === type).length;
        if (type === 'title' && beat.index - lastTitleBeat < MIN_BEATS_BETWEEN_TITLES) {
          problem = ['type_density', `${where}: chapter card too soon after the last one`];
        } else if (trailing(recent, (t) => t === type) >= MAX_SAME_TYPE_RUN) {
          problem = ['same_type_run', `${where}: a third "${type}" in a row became footage`];
        } else if (trailing(recent, (t) => kindOf(t) !== 'footage') >= MAX_NON_FOOTAGE_RUN) {
          problem = ['non_footage_run', `${where}: a third graphic in a row ("${type}") became footage`];
        } else if ((kind === 'graphic' || type === 'kinetic_text') && !DENSITY_EXEMPT.has(type) && inWindow >= MAX_SAME_TYPE_IN_WINDOW) {
          problem = ['type_density', `${where}: too many "${type}" shots close together; this one became footage`];
        } else if (shareRules && type === 'kinetic_text' && textCount >= allowedText) {
          problem = ['text_overuse', `${where}: text card beyond the video's share became footage`];
        }
      }
      if (problem) {
        fixes.push({ rule: problem[0], beat: beat.index, shot: i, message: problem[1] });
        const footage = planAsFootage(beat, shot);
        recent.push(footage.visual_type);
        return footage;
      }
      if (type === 'title') lastTitleBeat = beat.index;
      if (kind === 'text') textCount++;
      recent.push(type);
      if (shot.annotation) {
        // Too soon after the last annotated photo: keep the shot, drop the annotation
        if (recent.length - 1 - lastAnnotated < MIN_SHOTS_BETWEEN_ANNOTATIONS) {
          const plain: ShotPlan = { ...shot };
          delete plain.annotation;
          return plain;
        }
        lastAnnotated = recent.length - 1;
      }
      return shot;
    }),
  }));

  if (!shareRules) return { beats: sequenced, fixes };

  // Too much of the video is graphics: turn the least essential into footage until it fits
  const seconds = (s: ShotPlan) => s.word_count / SPEECH_WORDS_PER_SECOND;
  const all = sequenced.flatMap((beat) => (beat.shots ?? []).map((shot, i) => ({ beat, i, shot })));
  const total = all.reduce((n, x) => n + seconds(x.shot), 0);
  let graphicSeconds = all.filter((x) => kindOf(x.shot.visual_type) !== 'footage').reduce((n, x) => n + seconds(x.shot), 0);
  const candidates = all
    .filter((x) => kindOf(x.shot.visual_type) !== 'footage')
    .sort((a, b) => (GRAPHIC_KEEP_PRIORITY[a.shot.visual_type] ?? 5) - (GRAPHIC_KEEP_PRIORITY[b.shot.visual_type] ?? 5));
  for (const x of candidates) {
    if (total <= 0 || graphicSeconds / total <= maxGraphicsShare) break;
    graphicSeconds -= seconds(x.shot);
    fixes.push({ rule: 'graphics_share', beat: x.beat.index, shot: x.i, message: `Beat ${x.beat.index + 1}, shot ${x.i + 1}: "${x.shot.visual_type}" became footage to keep graphics under ${Math.round(maxGraphicsShare * 100)}% of the video` });
    x.beat.shots![x.i] = planAsFootage(x.beat, x.shot);
  }
  return { beats: sequenced, fixes };
}

/** repairRhythm without the list of changes. */
export function enforceShotVariety(beats: ScriptBeat[]): ScriptBeat[] {
  return repairRhythm(beats).beats;
}

function toShotPlan(shot: DirectorShot & { word_start: number; word_count: number }): ShotPlan {
  const plan: ShotPlan = {
    visual_type: shot.visual_type,
    visual_query: shot.visual_query.trim(),
    covers: shot.covers,
    word_start: shot.word_start,
    word_count: shot.word_count,
  };
  if (shot.fact_ids?.length) plan.fact_ids = shot.fact_ids;
  if (shot.visual_type === 'chart' && shot.chart) {
    const { annotations, ...chart } = shot.chart;
    plan.chart = { ...chart, unit: chart.unit ?? undefined, ...(annotations?.length ? { annotations } : {}) };
  }
  if (shot.visual_type === 'pitch' && shot.pitch) {
    plan.pitch = {
      title: shot.pitch.title ?? undefined,
      players: shot.pitch.players.map((p) => ({ label: p.label, x: p.x, y: p.y, team: p.team, ...(p.to ? { to: p.to } : {}) })),
      ball: shot.pitch.ball,
      outcome: shot.pitch.outcome ?? null,
    };
  }
  if (shot.visual_type === 'evidence_board' && shot.evidence) {
    plan.evidence = {
      title: shot.evidence.title ?? undefined,
      items: shot.evidence.items.map((it) => ({ kind: it.kind, label: it.label, detail: it.detail ?? undefined })),
      links: shot.evidence.links.map((l) => [l[0], l[1]] as [number, number]),
    };
  }
  if (shot.visual_type === 'letter' && shot.letter) {
    plan.letter = { writer: shot.letter.writer, recipient: shot.letter.recipient ?? undefined, date: shot.letter.date ?? undefined, text: shot.letter.text };
  }
  if (shot.visual_type === 'race_bars' && shot.race) {
    plan.race = { ...shot.race, unit: shot.race.unit ?? undefined };
  }
  if (shot.visual_type === 'scale' && shot.scale) {
    plan.scale = { title: shot.scale.title ?? undefined, items: shot.scale.items };
  }
  if (shot.visual_type === 'spec_card' && shot.spec) {
    plan.spec = { title: shot.spec.title, subject: shot.spec.subject ?? undefined, rows: shot.spec.rows };
  }
  if (shot.visual_type === 'money' && shot.money) plan.money = shot.money;
  if (shot.visual_type === 'stat' && shot.stat) {
    plan.stat = { ...shot.stat, prefix: shot.stat.prefix ?? undefined, suffix: shot.stat.suffix ?? undefined };
  }
  if (shot.visual_type === 'quote' && shot.quote) plan.quote = shot.quote;
  if (shot.visual_type === 'geo_map' && shot.map) plan.map = shot.map;
  if (shot.visual_type === 'newspaper' && shot.newspaper) plan.newspaper = shot.newspaper;
  if (shot.visual_type === 'timeline' && shot.timeline) plan.timeline = shot.timeline;
  if (shot.visual_type === 'comparison' && shot.comparison) {
    plan.comparison = { ...shot.comparison, title: shot.comparison.title ?? undefined };
  }
  if (shot.visual_type === 'title' && shot.title_card) {
    plan.title_card = { text: shot.title_card.text, kicker: shot.title_card.kicker ?? undefined };
  }
  if (shot.visual_type === 'kinetic_text' && shot.kinetic) plan.kinetic = shot.kinetic;
  if (shot.visual_type === 'diagram' && shot.diagram) {
    plan.diagram = {
      kind: shot.diagram.kind,
      title: shot.diagram.title ?? undefined,
      center: shot.diagram.center ?? undefined,
      steps: shot.diagram.steps.map((s) => ({ label: s.label, detail: s.detail ?? undefined })),
    };
  }
  if ((shot.visual_type === 'stock' || shot.visual_type === 'archive') && shot.caption) {
    plan.caption = { name: shot.caption.name, detail: shot.caption.detail ?? undefined };
  }
  if ((shot.visual_type === 'stock' || shot.visual_type === 'archive') && shot.annotation) {
    plan.annotation = { target: shot.annotation.target, label: shot.annotation.label, detail: shot.annotation.detail ?? undefined };
  }
  return plan;
}

function planAsFootage(beat: ScriptBeat, shot: ShotPlan): ShotPlan {
  return {
    visual_type: beat.visual_type === 'archive' ? 'archive' : 'stock',
    visual_query: toStockQuery(shot.visual_query) || beat.visual_query,
    covers: shot.covers,
    word_start: shot.word_start,
    word_count: shot.word_count,
    fact_ids: shot.fact_ids,
  };
}

/**
 * Gives every graphic enough screen time to be read: a timeline keeps only as many events as
 * fit, and a graphic that can't fit becomes footage. Times are estimated from the words the
 * shot plays under.
 */
export function fitGraphicsToTime(beat: ScriptBeat, shots: ShotPlan[]): ShotPlan[] {
  return shots.map((shot) => {
    const seconds = shot.word_count / SPEECH_WORDS_PER_SECOND;
    if (shot.visual_type === 'diagram' && shot.diagram) {
      const fits = Math.floor(seconds / SECONDS_PER_DIAGRAM_STEP);
      if (fits < MIN_DIAGRAM_STEPS) return planAsFootage(beat, shot);
      return fits < shot.diagram.steps.length ? { ...shot, diagram: { ...shot.diagram, steps: shot.diagram.steps.slice(0, fits) } } : shot;
    }
    if (shot.visual_type === 'timeline' && shot.timeline) {
      const fits = Math.floor(seconds / SECONDS_PER_TIMELINE_EVENT);
      if (fits < 2) return planAsFootage(beat, shot);
      return fits < shot.timeline.events.length
        ? { ...shot, timeline: { events: shot.timeline.events.slice(0, fits) } }
        : shot;
    }
    const min = MIN_GRAPHIC_SECONDS[shot.visual_type];
    return min && seconds < min ? planAsFootage(beat, shot) : shot;
  });
}

/** Validates, aligns, and converts the director's shots for one beat. */
export function finalizeBeatShots(beat: ScriptBeat, shots: DirectorShot[], facts: ResearchFact[], signature: SignatureOptions = {}): ShotPlan[] {
  const allowed = new Set<string>(signature.signature ?? []);
  const verified = shots
    // A signature shot outside its style becomes footage; callouts only where the style has them
    .map((s) => ((SIGNATURE_SHOT_TYPES as readonly string[]).includes(s.visual_type) && !allowed.has(s.visual_type) ? footageFallback(beat, s) : s))
    .map((s) => (s.chart?.annotations && !signature.chartCallouts ? { ...s, chart: { ...s.chart, annotations: null } } : s))
    .map((s) => verifyShot(s, beat, facts));
  return fitGraphicsToTime(beat, alignShotsToNarration(beat.text, verified).map(toShotPlan));
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

/**
 * Adds a shot plan to every beat. Batches long scripts, carrying the last shot types across
 * batches for variety. Never throws: beats whose batch fails keep their beat-level visual.
 */
export interface PlanShotsOptions {
  /** Plan only these beat indexes (e.g. beats edited on the review page); others keep their shots. */
  onlyBeats?: number[];
  /** The video's style: its pack adds director notes and sets the graphics limit. */
  style?: string | null;
}

export async function planShots(
  supabase: SupabaseClient,
  script: GeneratedScript,
  topic: string,
  options: PlanShotsOptions = {},
): Promise<GeneratedScript> {
  try {
    const resolved = await resolveForStage<LLMProvider>('script', supabase);
    const ctx = withWritingModel(resolved.ctx, resolved.options);
    return await planShotsWith(resolved.provider, ctx, script, topic, options);
  } catch (err) {
    console.warn('[planShots] Shot planning unavailable; keeping beat-level visuals:', err);
    return script;
  }
}

export async function planShotsWith(
  llm: LLMProvider,
  ctx: ProviderCallContext,
  script: GeneratedScript,
  topic: string,
  options: PlanShotsOptions = {},
): Promise<GeneratedScript> {
  const facts = script.research?.facts ?? [];
  const pack = stylePack(options.style);
  const maxGraphicsShare = pack?.maxGraphicsShare ?? MAX_GRAPHICS_SHARE;
  const signature: SignatureOptions = { signature: pack?.signatureShots, chartCallouts: pack?.chartCallouts };
  const planned = new Map<number, ShotPlan[]>();
  let previousTypes: ShotType[] = [];
  const toPlan = options.onlyBeats
    ? script.beats.filter((b) => options.onlyBeats!.includes(b.index))
    : script.beats;

  for (let i = 0; i < toPlan.length; i += BEATS_PER_BATCH) {
    const batch = toPlan.slice(i, i + BEATS_PER_BATCH);
    try {
      const { data } = await llm.generateJson(
        {
          system: DIRECTOR_SYSTEM,
          prompt: buildBatchPrompt(topic, batch, facts, previousTypes, pack?.directorNotes, signature),
          schema: DirectorResponseSchema,
        },
        ctx,
      );
      const byIndex = new Map(data.beats.map((b) => [b.index, b.shots]));
      for (const beat of batch) {
        const shots = byIndex.get(beat.index);
        if (shots?.length) planned.set(beat.index, finalizeBeatShots(beat, shots, facts, signature));
      }
    } catch (err) {
      console.warn(`[planShots] Batch starting at beat ${i} failed; those beats keep beat-level visuals:`, err);
    }
    previousTypes = batch.flatMap((b) => planned.get(b.index) ?? []).map((s) => s.visual_type).slice(-3);
  }

  const { beats, fixes } = repairRhythm(
    script.beats.map((beat) => (planned.has(beat.index) ? { ...beat, shots: planned.get(beat.index) } : beat)),
    maxGraphicsShare,
  );
  const rhythm = analyzeRhythm(planToRhythmShots(beats), 'plan', fixes, maxGraphicsShare);
  const shotCount = [...planned.values()].reduce((n, shots) => n + shots.length, 0);
  console.log(
    `[planShots] Planned ${shotCount} shots across ${planned.size}/${toPlan.length} beats; rhythm ${rhythm.score}/100 (${fixes.length} fixed, ${rhythm.issues.length - fixes.length} remaining)`,
  );
  // A new plan makes any earlier render report stale
  return { ...script, beats, rhythm: { plan: rhythm } };
}
