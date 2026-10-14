import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider, ProviderCallContext } from '@/pipeline/providers/types';
import type { ResearchFact } from '@/lib/research/types';
import {
  SHOT_TYPES,
  withWritingModel,
  type GeneratedScript,
  type ScriptBeat,
  type ShotPlan,
  type ShotType,
} from './generate-script';
import { SPEECH_WORDS_PER_SECOND, STREET_LEVEL_PLACE, estimateSpeechSeconds, toStockQuery } from './script-quality';

/** Target on-screen time per shot; viewers expect the picture to change every 3-6 seconds. */
const SECONDS_PER_SHOT = 4.5;
const MAX_SHOTS_PER_BEAT = 4;
/** ~2.2s at narration pace; shorter cuts feel choppy on footage. */
const MIN_WORDS_PER_SHOT = 5;
const BEATS_PER_BATCH = 12;
const GRAPHIC_TYPES = new Set<ShotType>(['chart', 'stat', 'quote', 'geo_map', 'newspaper', 'timeline', 'comparison', 'title', 'kinetic_text']);
const MAX_SAME_GRAPHIC_IN_A_ROW = 2;
/** Chapter cards mark real turns in the story; closer together they stop meaning anything. */
const MIN_BEATS_BETWEEN_TITLES = 6;
const MAX_TITLE_WORDS = 8;
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
};
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
- Each beat states how many shots it needs. Split its narration into exactly that many consecutive parts at natural phrase boundaries. "covers" is the exact words of that part, in order; together the parts cover the whole beat.
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
- Footage of a specific named person or place may carry caption = {name, detail}, a lower-third such as {name: "Herbert Hoover", detail: "U.S. President, 1929-33"}. Only names and details stated in the narration or research.

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
  caption: nullableObject({ name: z.string(), detail: z.string().nullable().optional() }),
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

  return `Video topic: "${topic}"

${factSection}${continuity}Plan the shots for these beats. Return {"beats": [{"index": ..., "shots": [...]}]} with one entry per beat.

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

  switch (shot.visual_type) {
    case 'stock':
    case 'archive': {
      if (!shot.caption) return shot;
      // A caption naming someone the narration never names would be an unchecked claim
      const name = shot.caption.name.trim();
      if (!name || !isNamed(name)) return { ...shot, caption: null };
      const detail = shot.caption.detail?.trim();
      const detailOk = detail && groundValues(quantitiesIn(detail)) !== null && detail.split(/\s+/).length <= 8;
      return { ...shot, caption: { name, detail: detailOk ? detail : null } };
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
      return { ...withFacts(extra), chart: { ...chart, labels, values } };
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

/**
 * Downgrades the third-in-a-row graphic of the same type (across beats) to footage, and any
 * chapter card closer than MIN_BEATS_BETWEEN_TITLES beats to the previous one.
 */
export function enforceShotVariety(beats: ScriptBeat[]): ScriptBeat[] {
  let runType: ShotType | null = null;
  let runLength = 0;
  let lastTitleBeat = -Infinity;
  return beats.map((beat) => ({
    ...beat,
    shots: beat.shots?.map((shot) => {
      const sameRun = GRAPHIC_TYPES.has(shot.visual_type) && shot.visual_type === runType;
      const titleTooSoon = shot.visual_type === 'title' && beat.index - lastTitleBeat < MIN_BEATS_BETWEEN_TITLES;
      if ((sameRun && runLength >= MAX_SAME_GRAPHIC_IN_A_ROW) || titleTooSoon) {
        runType = null;
        runLength = 0;
        return planAsFootage(beat, shot);
      }
      if (shot.visual_type === 'title') lastTitleBeat = beat.index;
      runLength = sameRun ? runLength + 1 : 1;
      runType = shot.visual_type;
      return shot;
    }),
  }));
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
    plan.chart = { ...shot.chart, unit: shot.chart.unit ?? undefined };
  }
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
  if ((shot.visual_type === 'stock' || shot.visual_type === 'archive') && shot.caption) {
    plan.caption = { name: shot.caption.name, detail: shot.caption.detail ?? undefined };
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
export function finalizeBeatShots(beat: ScriptBeat, shots: DirectorShot[], facts: ResearchFact[]): ShotPlan[] {
  const verified = shots.map((s) => verifyShot(s, beat, facts));
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
          prompt: buildBatchPrompt(topic, batch, facts, previousTypes),
          schema: DirectorResponseSchema,
        },
        ctx,
      );
      const byIndex = new Map(data.beats.map((b) => [b.index, b.shots]));
      for (const beat of batch) {
        const shots = byIndex.get(beat.index);
        if (shots?.length) planned.set(beat.index, finalizeBeatShots(beat, shots, facts));
      }
    } catch (err) {
      console.warn(`[planShots] Batch starting at beat ${i} failed; those beats keep beat-level visuals:`, err);
    }
    previousTypes = batch.flatMap((b) => planned.get(b.index) ?? []).map((s) => s.visual_type).slice(-3);
  }

  const beats = enforceShotVariety(
    script.beats.map((beat) => (planned.has(beat.index) ? { ...beat, shots: planned.get(beat.index) } : beat)),
  );
  const shotCount = [...planned.values()].reduce((n, shots) => n + shots.length, 0);
  console.log(`[planShots] Planned ${shotCount} shots across ${planned.size}/${toPlan.length} beats`);
  return { ...script, beats };
}
