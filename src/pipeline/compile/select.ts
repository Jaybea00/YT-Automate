import type { RecipeId } from '../hunter/types';
import type { CompilationFormat, LibraryItem } from './types';

export interface ThemeFilter {
  recipes?: RecipeId[];
  creator?: string;
  /** Only items added in the last N days. */
  sinceDays?: number;
  /** Leave out items already used in a compilation. */
  unusedOnly?: boolean;
}

export interface ThemeSuggestion {
  name: string;
  filter: ThemeFilter;
  /** How many items fit. */
  available: number;
}

const RECIPE_THEMES: Record<RecipeId, string> = {
  funny: 'Funniest GTA 6 moments',
  chase: 'Best police chases',
  crash: 'Craziest crashes and chaos',
  clutch: 'Most clutch plays',
  rage: 'Biggest rage moments',
  glitch: 'Weirdest glitches',
  other: 'Wildest moments',
};

/** Most clips per format. */
export const DEFAULT_COUNT: Record<CompilationFormat, number> = { short: 4, long: 12 };
/** Fewest clips for a theme to be suggested. */
const MIN_FOR_THEME = 3;

const scoreOf = (i: LibraryItem) => i.score ?? 6;

export function matches(item: LibraryItem, f: ThemeFilter, now = Date.now()): boolean {
  if (f.recipes?.length && !f.recipes.includes(item.recipe)) return false;
  if (f.creator && item.creator.toLowerCase() !== f.creator.toLowerCase()) return false;
  if (f.sinceDays && now - Date.parse(item.createdAt) > f.sinceDays * 86400_000) return false;
  if (f.unusedOnly && item.usedIn.length) return false;
  return true;
}

/** Themes the library can fill: one per recipe and per streamer with enough unused clips, plus a best-of. */
export function suggestThemes(items: LibraryItem[]): ThemeSuggestion[] {
  const out: ThemeSuggestion[] = [];
  const count = (f: ThemeFilter) => items.filter((i) => matches(i, f)).length;
  const best: ThemeFilter = { unusedOnly: true };
  if (count(best) >= MIN_FOR_THEME) out.push({ name: 'Best GTA 6 moments', filter: best, available: count(best) });
  for (const recipe of Object.keys(RECIPE_THEMES) as RecipeId[]) {
    if (recipe === 'other') continue;
    const f: ThemeFilter = { recipes: [recipe], unusedOnly: true };
    const n = count(f);
    if (n >= MIN_FOR_THEME) out.push({ name: RECIPE_THEMES[recipe], filter: f, available: n });
  }
  const creators = [...new Set(items.map((i) => i.creator).filter(Boolean))];
  for (const creator of creators) {
    const f: ThemeFilter = { creator, unusedOnly: true };
    const n = count(f);
    if (n >= MIN_FOR_THEME) out.push({ name: `${creator}'s craziest moments`, filter: f, available: n });
  }
  return out.sort((a, b) => b.available - a.available);
}

export function themeName(f: ThemeFilter): string {
  if (f.creator) return `${f.creator}'s craziest moments`;
  if (f.recipes?.length === 1) return RECIPE_THEMES[f.recipes[0]];
  return 'Best GTA 6 moments';
}

/**
 * The best items for a theme: highest score first, and when several streamers are in the mix no
 * one of them takes more than half the slots.
 */
export function pickForTheme(items: LibraryItem[], f: ThemeFilter, count: number): LibraryItem[] {
  const pool = items.filter((i) => matches(i, f)).sort((a, b) => scoreOf(b) - scoreOf(a));
  const creators = new Set(pool.map((i) => i.creator));
  const cap = creators.size > 1 ? Math.max(1, Math.ceil(count / 2)) : count;
  const perCreator = new Map<string, number>();
  const picked: LibraryItem[] = [];
  for (const item of pool) {
    if (picked.length >= count) break;
    const n = perCreator.get(item.creator) ?? 0;
    if (n >= cap) continue;
    perCreator.set(item.creator, n + 1);
    picked.push(item);
  }
  // Too few after the cap: fill with what's left
  for (const item of pool) {
    if (picked.length >= count) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked;
}

/**
 * Running order: the second-best opens (a strong start), then rising, the best last (the payoff).
 * Where it can, the same streamer doesn't appear twice in a row.
 */
export function orderClips<T extends { score: number | null; creator: string }>(items: T[]): T[] {
  const byScore = [...items].sort((a, b) => (b.score ?? 6) - (a.score ?? 6));
  if (byScore.length < 3) return byScore.reverse();
  const ordered = [byScore[1], ...byScore.slice(2).reverse(), byScore[0]];
  for (let i = 1; i < ordered.length - 1; i++) {
    if (ordered[i].creator !== ordered[i - 1].creator) continue;
    const swap = ordered.findIndex((x, j) => j > i && j < ordered.length - 1 && x.creator !== ordered[i - 1].creator);
    if (swap > 0) [ordered[i], ordered[swap]] = [ordered[swap], ordered[i]];
  }
  return ordered;
}

/**
 * The part of an item used in a Short compilation: all of it when it fits the time it's given,
 * otherwise a window around its loudest moment (more before it than after, for the build-up).
 */
export function trimToBudget(range: { start: number; end: number }, peakSec: number | null, budgetSec: number): { start: number; end: number } {
  const len = range.end - range.start;
  if (len <= budgetSec) return range;
  const peak = peakSec != null && peakSec >= range.start && peakSec <= range.end ? peakSec : range.start + len / 2;
  let start = peak - budgetSec * 0.65;
  let end = start + budgetSec;
  if (start < range.start) {
    start = range.start;
    end = start + budgetSec;
  }
  if (end > range.end) {
    end = range.end;
    start = end - budgetSec;
  }
  return { start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 };
}
