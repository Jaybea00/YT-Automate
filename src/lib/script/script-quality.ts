import type { ScriptBeat } from './generate-script';
import type { ResearchDossier } from '@/lib/research/types';

/**
 * Narration pace used for runtime planning. Measured from real narrator output
 * (434 words spoken in 183.7s ≈ 2.36 words/sec) and rounded down slightly so the
 * short pauses inserted between beats are absorbed into the target.
 */
export const SPEECH_WORDS_PER_SECOND = 2.3;

/** Allowed deviation from the target word count before a correction pass runs. */
export const LENGTH_TOLERANCE = 0.08;

/**
 * Average words per beat to plan around. Models hit a beat count far more reliably than a
 * total word count, so the budget is expressed as "N beats of about this many words".
 */
export const TARGET_WORDS_PER_BEAT = 24;

export interface WordBudget {
  target: number;
  min: number;
  max: number;
  /** Beat count that reaches the target at TARGET_WORDS_PER_BEAT. */
  targetBeats: number;
}

/**
 * Short, stable signature of a script's narration (djb2 over beat texts). Works in the
 * browser too, so the review page can tell when a saved review no longer matches the script.
 */
export function scriptTextSignature(beats: Pick<ScriptBeat, 'text'>[]): string {
  let hash = 5381;
  const text = beats.map((b) => b.text.trim()).join('␞');
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${beats.length}-${(hash >>> 0).toString(36)}`;
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function countScriptWords(beats: Pick<ScriptBeat, 'text'>[]): number {
  return beats.reduce((sum, b) => sum + countWords(b.text || ''), 0);
}

export function estimateSpeechSeconds(text: string): number {
  return Math.max(1, Math.round((countWords(text) / SPEECH_WORDS_PER_SECOND) * 10) / 10);
}

export function wordBudgetForMinutes(targetMinutes: number): WordBudget {
  const target = Math.round(targetMinutes * 60 * SPEECH_WORDS_PER_SECOND);
  return {
    target,
    min: Math.round(target * (1 - LENGTH_TOLERANCE)),
    max: Math.round(target * (1 + LENGTH_TOLERANCE)),
    targetBeats: Math.max(3, Math.round(target / TARGET_WORDS_PER_BEAT)),
  };
}

const NUMBER_WORD =
  /^(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|half|double|triple|percent)$/i;

function isNumberToken(token: string): boolean {
  return /^[$£€]?\d[\d,.]*%?$/.test(token) || NUMBER_WORD.test(token);
}

/**
 * Counts distinct quantities in narration. Consecutive number tokens form one quantity,
 * so "sixteen million", "twenty-five percent" and "$30 billion" each count once.
 */
export function countQuantities(text: string): number {
  const rawTokens = text.replace(/-/g, ' ').split(/\s+/).filter(Boolean);

  let quantities = 0;
  let inQuantity = false;
  for (const raw of rawTokens) {
    const token = raw.replace(/^[^\w$£€]+|[^\w%]+$/g, '');
    // "point" continues a spoken decimal ("sixteen point four million") but is not a number alone
    const numeric: boolean = isNumberToken(token) || (inQuantity && token.toLowerCase() === 'point');
    if (numeric && !inQuantity) quantities++;
    // Punctuation after a number ends it: "$30 billion, ten times" is two quantities
    inQuantity = numeric && !/[,.;:!?)]$/.test(raw);
  }
  return quantities;
}

/** Narration that quotes someone or names a headline. */
const QUOTED_TEXT = /["“][^"”]{3,}["”]/;

/**
 * Keeps only fact ids that exist in the dossier, and flags beats that state numbers or
 * quotes without any backing fact so they can be checked before approval.
 */
export function applyResearchToBeats(
  beats: ScriptBeat[],
  dossier: ResearchDossier,
  options: { enforceVisualRules?: boolean } = {},
): ScriptBeat[] {
  const { enforceVisualRules = true } = options;
  const factById = new Map(dossier.facts.map((f) => [f.id, f]));
  return beats.map((beat) => {
    const factIds = [...new Set((beat.fact_ids ?? []).map((id) => id.trim()).filter((id) => factById.has(id)))];
    const hasSpecifics = countQuantities(beat.text) > 0 || QUOTED_TEXT.test(beat.text);
    const checked = { ...beat, fact_ids: factIds, needs_check: hasSpecifics && factIds.length === 0 };

    // A newspaper visual reproduces a headline, so it needs a researched fact that quotes one
    const citesHeadline = factIds.some((id) => QUOTED_TEXT.test(factById.get(id)!.claim));
    if (enforceVisualRules && beat.visual_type === 'newspaper' && !citesHeadline) {
      return { ...checked, visual_type: 'archive', visual_query: beat.visual_query.replace(/\s*\|\s*/g, ' ').trim() };
    }
    return checked;
  });
}

/** Map queries naming streets, buildings or neighbourhoods: too zoomed-in for a geographic map. */
export const STREET_LEVEL_PLACE =
  /\b(street|st|avenue|ave|road|rd|boulevard|lane|block|blocks|building|floor|square|district|neighbou?rhood|downtown|lower manhattan|midtown)\b/i;

function guardedVisualType(beat: ScriptBeat): ScriptBeat['visual_type'] {
  if (beat.visual_type === 'chart' && countQuantities(beat.text) < 2) return 'stock';
  if (beat.visual_type === 'geo_map' && STREET_LEVEL_PLACE.test(beat.visual_query)) return 'stock';
  return beat.visual_type;
}

/** Turns a chart/map spec ("line chart: X", "map: A -> B") into a plain footage search phrase. */
export function toStockQuery(query: string): string {
  return query
    .replace(/^\s*(?:[\w-]+\s+)?(?:chart|map)\s*:\s*/i, '')
    .replace(/\s*->\s*/g, ', ')
    .trim();
}

/**
 * Deterministic clean-up applied to every AI-produced script:
 * - drops empty beats and renumbers indexes 0..n-1 (assembly keys assets by position)
 * - replaces the model's guessed durations with word-count estimates
 * - downgrades "chart" beats that state fewer than two quantities (nothing to plot) to "stock"
 * - downgrades street/building-level "geo_map" beats (a world map can't show them) to "stock"
 */
export function normalizeBeats(beats: ScriptBeat[]): ScriptBeat[] {
  return beats
    .map((b) => ({ ...b, text: (b.text || '').trim(), visual_query: (b.visual_query || '').trim() }))
    .filter((b) => b.text.length > 0)
    .map((b, idx) => {
      const visualType = guardedVisualType(b);
      return {
        ...b,
        index: idx,
        visual_type: visualType,
        visual_query: visualType === b.visual_type ? b.visual_query : toStockQuery(b.visual_query),
        duration_estimate_seconds: estimateSpeechSeconds(b.text),
      };
    });
}
