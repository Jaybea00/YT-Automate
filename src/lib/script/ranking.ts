/**
 * Ranking Shorts: a vertical countdown ("Top 5 heists that actually worked") of about a minute.
 * The script opens on a teaser of #1, counts down with one short reason per item and ends on #1.
 * Each item's first beat starts "Number 3: <name>." — that marker is what puts the "#3" badge on
 * screen, so it works the same for scripts the AI writes and scripts pasted in. Browser-safe.
 */

/** How many items a ranking Short counts down: a Top 5 (about a minute) or a Top 10 (about two). */
export type RankingSize = 5 | 10;
export const RANKING_SIZES: RankingSize[] = [5, 10];
export const isRankingSize = (n: unknown): n is RankingSize => n === 5 || n === 10;

/** Spoken words for a ranking of `items`: a hook, about 22 words an item, a little more for #1. */
export const rankingWords = (items: RankingSize) => 15 + items * 22;

/** Narration length for a ranking Short: about 50 s for a Top 5, about 1:45 for a Top 10 (Shorts may run to 3 minutes). */
export const rankingMinutes = (items: RankingSize) => Math.round((rankingWords(items) / 2.5 / 60) * 100) / 100;

export function rankingShortRules(items: RankingSize = 5): string {
  return RANKING_SHORT_RULES.replace('{ITEMS}', String(items))
    .replace('{WORDS}', String(rankingWords(items)))
    .replace('{LENGTH}', items >= 10 ? 'about two minutes' : 'under a minute');
}

export const RANKING_SHORT_RULES = `THIS IS A RANKING SHORT: a vertical countdown, {LENGTH} (about {WORDS} spoken words in all).
- Rank {ITEMS} items of one tight theme, counting down to the best.
- Beat 1 is a hook that teases number one without naming it ("Number one was never caught."). No intro, no "in this video".
- Each item starts its own beat with exactly "Number N: <name>." (N as a word or digit, the name 2-5 words), e.g. "Number 3: The Antwerp Diamond Heist." Never put "Number N" at the start of any other beat.
- Then one or two fast lines for that item: the single most surprising fact and why it earns its rank. Real names, numbers and dates only.
- Number one gets the most time and the hardest-hitting detail.
- End on number one's payoff line. No recap and no call to subscribe. Don't ask viewers for their own number one: the closing question is added after your last beat.`;

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const MARKER = /^\s*["'“‘]?(?:and\s+)?(?:at\s+)?(?:number|no\.|#)\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

/** The rank a beat opens with ("Number 3:", "#3", "No. 3", "At number three,"), or null. */
export function rankOfBeat(text: string): number | null {
  const m = MARKER.exec(text);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUMBERS[m[1].toLowerCase()];
  return n >= 1 && n <= 10 ? n : null;
}

/**
 * The item's name right after its marker ("Number 3: The Antwerp Heist." -> "The Antwerp Heist"),
 * if it's short. The dots in initials ("D.B. Cooper") don't end it.
 */
export function rankName(text: string): string {
  const m = MARKER.exec(text);
  if (!m) return '';
  const rest = text.slice(m[0].length).replace(/^\s*[:,.—–-]?\s*/, '');
  const end = /^(.+?)(?<!(?:^|[\s.])\p{Lu})(?:[.!?:]|\s[—–-])(?=\s|$)/u.exec(rest);
  const name = end?.[1]?.trim().replace(/["'”’,]+$/, '') ?? '';
  const words = name.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 6 ? name : '';
}

export interface RankMarker {
  /** Position of the beat in the script. */
  beat: number;
  rank: number;
  name: string;
}

/**
 * Where each ranked item starts. A rank said twice (the hook teasing number one) counts where it
 * is said last; ranks must then count down, and anything out of order is ignored. Fewer than two
 * items means it isn't a ranking at all.
 */
export function rankMarkers(beats: Array<{ text: string }>): RankMarker[] {
  const last = new Map<number, number>();
  beats.forEach((b, i) => {
    const rank = rankOfBeat(b.text);
    if (rank != null) last.set(rank, i);
  });
  const ordered = [...last.entries()].map(([rank, beat]) => ({ rank, beat })).sort((a, b) => a.beat - b.beat);
  const out: RankMarker[] = [];
  for (const m of ordered) {
    if (out.length && m.rank >= out[out.length - 1].rank) continue;
    out.push({ ...m, name: rankName(beats[m.beat].text) });
  }
  return out.length >= 2 ? out : [];
}

/** The on-screen badge for an item: "#3 THE ANTWERP HEIST", or just "#3". */
export function rankBadge(m: Pick<RankMarker, 'rank' | 'name'>): string {
  return `#${m.rank}${m.name ? ` ${m.name.toUpperCase()}` : ''}`;
}

export const RANKING_END_CARD = 'WHAT WOULD YOUR #1 BE?';
/** Said over the end card, so the Short closes on a question viewers answer in the comments. */
export const RANKING_CLOSING_LINE = 'What would your number one be?';

const isClosingLine = (text: string) => /\byour\s+(?:number\s+one|#\s?1|no\.\s?1)\b/i.test(text);

/** Where the closing question starts (a beat position), or -1 when the script doesn't end on it. */
export function closingBeat(beats: Array<{ text: string }>): number {
  const last = beats.length - 1;
  return last >= 1 && isClosingLine(beats[last].text) ? last : -1;
}

/**
 * The beats with the closing question as their last beat (added once). It keeps number one's
 * picture on screen: the same visual as the beat before it.
 */
export function withClosingLine<B extends { index: number; text: string; visual_type: string; visual_query: string; duration_estimate_seconds: number }>(beats: B[]): B[] {
  if (!beats.length || closingBeat(beats) >= 0) return beats;
  const last = beats[beats.length - 1];
  return [
    ...beats,
    { ...last, index: last.index + 1, text: RANKING_CLOSING_LINE, duration_estimate_seconds: 2, fact_ids: undefined, needs_check: undefined } as B,
  ];
}

/** A script marked as a ranking Short of its own (no long video behind it), ending on the closing question. */
export function asRankingShort<T extends object>(script: T, hookBanner?: string | null): T & {
  format: 'short';
  ranking: true;
  short: { parent_video_id: null; hook_banner: string };
  beat_pause_seconds: number;
} {
  const beats = (script as { beats?: unknown }).beats;
  return {
    ...script,
    ...(Array.isArray(beats) ? { beats: withClosingLine(beats) } : {}),
    format: 'short',
    ranking: true,
    short: { parent_video_id: null, hook_banner: (hookBanner || (script as { title_options?: string[] }).title_options?.[0] || '').trim() },
    // Shorts move fast: no extra pause between beats
    beat_pause_seconds: 0,
  };
}
