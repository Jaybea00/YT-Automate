import type { ShotPlan } from '@/lib/script/generate-script';

/**
 * When no footage clearly shows a shot, a graphic made from the shot's own words beats a so-so
 * clip or a plain text card: a number in the narration becomes a stat card, a country a map.
 * Anything else still becomes the narration as type (the existing fallback).
 */

const UNIT_SUFFIX: Record<string, string> = { percent: '%', 'per cent': '%', '%': '%', thousand: 'K', million: 'M', billion: 'B', trillion: 'T' };
const LABEL_STOP = new Set(['of', 'in', 'on', 'at', 'the', 'a', 'an', 'and', 'for', 'from', 'by', 'than', 'more', 'over', 'about', 'nearly', 'almost', 'roughly', 'around']);
const NUMBER = /(?:([$£€])\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(%|percent|per cent|thousand|million|billion|trillion))?/gi;

/** A stat card from the first real quantity in the words (not a year), with what it counts. */
export function statFromNarration(text: string): ShotPlan['stat'] | null {
  for (const m of text.matchAll(NUMBER)) {
    const [whole, currency, digits, unitRaw] = m;
    const unit = unitRaw?.toLowerCase();
    const value = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    // A bare year is a date, not a stat
    if (!currency && !unit && /^(1[5-9]\d{2}|20\d{2})$/.test(digits)) continue;
    const after = text.slice((m.index ?? 0) + whole.length).split(/[.,;:!?()]/)[0];
    const label = after
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
      .filter((w, i, all) => !(LABEL_STOP.has(w.toLowerCase()) && (i === 0 || i === all.length - 1)))
      .slice(0, 4)
      .join(' ')
      .replace(/[^\p{L}\p{N}\s'’-]/gu, '')
      .trim();
    if (!label || !/\p{L}{3,}/u.test(label)) continue;
    return { value, ...(currency ? { prefix: currency } : {}), ...(unit ? { suffix: UNIT_SUFFIX[unit] } : {}), label };
  }
  return null;
}

/** Runs of capitalised words that could name a place ("United Kingdom", "Egypt"). */
export function capitalisedNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b([A-Z][\p{L}'’-]+(?:\s+(?:of\s+)?[A-Z][\p{L}'’-]+)*)/gu)) out.push(m[1]);
  return [...new Set(out)];
}

/**
 * The graphic for a shot no footage fits, or null when its words suggest none. `isCountry` says
 * whether a name is a country the map can draw.
 */
export function graphicForWeakShot(shot: ShotPlan, isCountry: (name: string) => boolean): ShotPlan | null {
  const words = shot.covers || shot.visual_query;
  const stat = statFromNarration(words);
  if (stat) return { ...shot, visual_type: 'stat', stat, visual_query: `${stat.prefix ?? ''}${stat.value}${stat.suffix ?? ''} ${stat.label}` };
  const country = capitalisedNames(words).find(isCountry);
  if (country) return { ...shot, visual_type: 'geo_map', map: { places: [country], mode: 'locate' }, visual_query: country };
  return null;
}
