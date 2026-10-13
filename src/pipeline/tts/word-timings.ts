import * as fs from 'node:fs/promises';

/** A word with its start and end time in seconds from the start of the beat's audio. */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface WordTimingsFile {
  version: 1;
  /** "provider": timings reported by the TTS engine; "estimated": derived from the audio. */
  source: 'provider' | 'estimated';
  /** The beat's narration as written (what captions and shot plans index into). */
  text: string;
  /** The text actually sent to the voice after speakable rewrites. */
  spokenText: string;
  durationMs: number;
  /** One entry per whitespace-separated word of `text`, in order. */
  words: WordTiming[];
}

export function wordTimingsPathFor(audioPath: string): string {
  return audioPath.replace(/\.[a-z0-9]+$/i, '') + '.words.json';
}

export async function saveWordTimings(audioPath: string, data: WordTimingsFile): Promise<string> {
  const target = wordTimingsPathFor(audioPath);
  await fs.writeFile(target, JSON.stringify(data, null, 2), 'utf-8');
  return target;
}

export async function loadWordTimings(audioPath: string): Promise<WordTimingsFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(wordTimingsPathFor(audioPath), 'utf-8')) as WordTimingsFile;
    return parsed.version === 1 && Array.isArray(parsed.words) ? parsed : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Aligning spoken tokens back to the written words
// --------------------------------------------------------------------------

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const SPOKEN_NUMBER_WORDS = new Set(
  `zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen
  seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million
  billion trillion point and percent dollars dollar pounds euros cents oh first second third fourth fifth
  sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth
  eighteenth nineteenth twentieth thirtieth st nd rd th a`
    .split(/\s+/)
    .filter(Boolean),
);

/** True when every part of a spoken token is a number word ("twenty-nine", "eighty-ninth"). */
const isSpokenNumber = (token: string) =>
  token
    .toLowerCase()
    .split(/[-\s]/)
    .filter(Boolean)
    .every((part) => SPOKEN_NUMBER_WORDS.has(part.replace(/[^\p{L}]/gu, '')));

const MAX_TOKENS_PER_WORD = 6;

/**
 * Roughly how many spoken words a written number becomes, used to break ties when
 * neighbouring numbers ("29, 1929") could split their spoken words either way.
 * "1929" -> 2 ("nineteen twenty-nine"), "41.22" -> 4, "89%" -> 2, "$14" -> 1.
 */
export function expectedSpokenWords(written: string): number {
  const [intPart = '', decimals = ''] = written.replace(/[^\d.%]/g, '').split('.');
  const digits = intPart.replace(/\D/g, '');
  const isYear = /^(1[1-9]|20)\d{2}$/.test(digits);
  let words = isYear ? 2 : Math.max(1, Math.ceil(digits.length / 2));
  if (decimals.replace(/\D/g, '')) words += 1 + decimals.replace(/\D/g, '').length;
  if (written.includes('%')) words += 1;
  return Math.min(MAX_TOKENS_PER_WORD, words);
}

/**
 * Maps timings of the spoken tokens (which may expand "1929" into "nineteen twenty-nine" or
 * "Oct." into "October") onto the written words of `text`, using an edit-distance alignment
 * where a numeric written word may absorb several spoken number words. Written words with no
 * spoken counterpart are interpolated between their neighbours.
 */
export function alignWordTimings(text: string, spoken: WordTiming[], durationSec: number): WordTiming[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const tokens = spoken.filter((t) => norm(t.word).length > 0);
  const n = words.length;
  const m = tokens.length;
  if (n === 0) return [];
  if (m === 0) return estimateWordTimings(text, durationSec);

  // cost[i][j]: best cost aligning words[0..i) with tokens[0..j); back stores the move
  const INF = Number.POSITIVE_INFINITY;
  const cost = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(INF));
  const back = Array.from({ length: n + 1 }, () => new Array<[number, number]>(m + 1));
  cost[0][0] = 0;

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = cost[i][j];
      if (here === INF) continue;
      const relax = (ni: number, nj: number, c: number) => {
        if (here + c < cost[ni][nj]) {
          cost[ni][nj] = here + c;
          back[ni][nj] = [i, j];
        }
      };
      if (i < n) relax(i + 1, j, 1); // written word not spoken separately
      if (j < m) relax(i, j + 1, 1); // extra spoken token
      if (i < n && j < m) {
        const w = norm(words[i]);
        relax(i + 1, j + 1, w === norm(tokens[j].word) ? 0 : 1);
        // A written number ("1929", "$14", "89%", "41.22") can span one or more spoken number
        // words; spans nearer its expected spoken length are preferred
        if (/\d/.test(words[i])) {
          const expected = expectedSpokenWords(words[i]);
          for (let k = 1; k <= MAX_TOKENS_PER_WORD && j + k <= m; k++) {
            if (!tokens.slice(j, j + k).every((t) => isSpokenNumber(t.word))) break;
            relax(i + 1, j + k, 0.1 + 0.05 * Math.abs(k - expected));
          }
        }
      }
    }
  }

  // Walk back, recording which token span each written word took
  const spans: Array<[number, number] | null> = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const [pi, pj] = back[i][j];
    if (pi === i - 1 && pj < j) spans[pi] = [pj, j - 1];
    i = pi;
    j = pj;
  }

  // Spoken tokens with no written word ("dollars" in "$14 billion") belong to the word before
  // them; extend that word to cover them so captions don't blank out mid-phrase
  const matchedSpans = spans.map((s, idx) => (s ? { idx, span: s } : null)).filter((s) => s !== null);
  for (let k = 0; k < matchedSpans.length; k++) {
    const { span } = matchedSpans[k]!;
    const nextStart = k + 1 < matchedSpans.length ? matchedSpans[k + 1]!.span[0] : m;
    if (nextStart - 1 > span[1]) span[1] = nextStart - 1;
  }

  const timed: Array<WordTiming | null> = words.map((word, idx) => {
    const span = spans[idx];
    return span ? { word, start: tokens[span[0]].start, end: tokens[span[1]].end } : null;
  });
  return fillGaps(words, timed, durationSec);
}

/** Interpolates untimed words between their timed neighbours, in proportion to word length. */
function fillGaps(words: string[], timed: Array<WordTiming | null>, durationSec: number): WordTiming[] {
  const out: WordTiming[] = [];
  let k = 0;
  while (k < words.length) {
    if (timed[k]) {
      out.push(timed[k]!);
      k++;
      continue;
    }
    let end = k;
    while (end < words.length && !timed[end]) end++;
    const from = out.length ? out[out.length - 1].end : 0;
    const to = end < words.length ? timed[end]!.start : durationSec;
    const gapWords = words.slice(k, end);
    const weights = gapWords.map((w) => Math.max(2, norm(w).length));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = from;
    gapWords.forEach((word, g) => {
      const len = ((Math.max(to, from) - from) * weights[g]) / total;
      out.push({ word, start: t, end: t + len });
      t += len;
    });
    k = end;
  }
  return out.map((w) => ({ word: w.word, start: round(w.start), end: round(w.end) }));
}

const round = (s: number) => Math.round(s * 1000) / 1000;

// --------------------------------------------------------------------------
// Estimating timings when the provider reports none
// --------------------------------------------------------------------------

export interface Silence {
  start: number;
  end: number;
}

/** Relative time a word takes: its length, plus a pause after commas and sentence ends. */
function wordWeight(word: string): { speak: number; pause: number } {
  const speak = Math.max(2, norm(word).length + (/\d/.test(word) ? norm(word).length * 1.5 : 0));
  const pause = /[.!?]["'”’)]*$/.test(word) ? 6 : /[,;:—–-]["'”’)]*$/.test(word) ? 3 : 0;
  return { speak, pause };
}

/**
 * Estimates word timings from text and audio length. When the audio's inner silences are
 * known, each one is matched to the nearest unclaimed punctuation pause, and words between
 * those anchors are spread by length, which keeps cuts at sentence and comma boundaries accurate.
 */
export function estimateWordTimings(text: string, durationSec: number, silences: Silence[] = []): WordTiming[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || durationSec <= 0) return [];

  const leading = silences.find((s) => s.start <= 0.05)?.end ?? 0;
  const trailing = silences.find((s) => s.end >= durationSec - 0.05)?.start ?? durationSec;
  const inner = silences.filter((s) => s.start > leading + 0.05 && s.end < trailing - 0.05);

  // Uniform estimate across the speech region
  const weights = words.map(wordWeight);
  const totalWeight = weights.reduce((sum, w) => sum + w.speak + w.pause, 0);
  const span = Math.max(0.1, trailing - leading);
  const estimated: WordTiming[] = [];
  let t = leading;
  for (let i = 0; i < words.length; i++) {
    const speak = (weights[i].speak / totalWeight) * span;
    estimated.push({ word: words[i], start: t, end: t + speak });
    t += speak + (weights[i].pause / totalWeight) * span;
  }

  // Anchor punctuation pauses to detected silences (pause after word i -> silence)
  const pauseAfter = weights.map((w, i) => (w.pause > 0 && i < words.length - 1 ? i : -1)).filter((i) => i >= 0);
  const anchors: Array<{ word: number; silence: Silence }> = [];
  const used = new Set<number>();
  for (const silence of inner) {
    const mid = (silence.start + silence.end) / 2;
    let best = -1;
    let bestDist = span * 0.15; // only snap to a pause that is plausibly the same one
    for (const i of pauseAfter) {
      if (used.has(i)) continue;
      const dist = Math.abs((estimated[i].end + estimated[i + 1].start) / 2 - mid);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    }
    if (best >= 0) {
      used.add(best);
      anchors.push({ word: best, silence });
    }
  }
  anchors.sort((a, b) => a.word - b.word);

  // Re-spread words between consecutive anchors so each segment fills its real speech time
  const out: WordTiming[] = [];
  let segStartWord = 0;
  let segStartTime = leading;
  for (const anchor of [...anchors, { word: words.length - 1, silence: { start: trailing, end: trailing } }]) {
    const segWords = words.slice(segStartWord, anchor.word + 1);
    const segWeights = weights.slice(segStartWord, anchor.word + 1);
    const segTotal = segWeights.reduce((sum, w, k) => sum + w.speak + (k < segWeights.length - 1 ? w.pause : 0), 0);
    const segSpan = Math.max(0.05, anchor.silence.start - segStartTime);
    let cursor = segStartTime;
    segWords.forEach((word, k) => {
      const speak = (segWeights[k].speak / segTotal) * segSpan;
      out.push({ word, start: round(cursor), end: round(cursor + speak) });
      cursor += speak + (k < segWords.length - 1 ? (segWeights[k].pause / segTotal) * segSpan : 0);
    });
    segStartWord = anchor.word + 1;
    segStartTime = anchor.silence.end;
  }
  return out;
}
