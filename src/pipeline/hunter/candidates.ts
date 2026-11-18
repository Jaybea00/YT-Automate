import { LOUDNESS_STEP } from '../clipping/types';
import { guessRecipe, reactionHits, RECIPES } from './recipes';
import { MAX_CANDIDATES, WINDOW_AFTER, WINDOW_BEFORE, type Candidate, type TimedText } from './types';

/** Seconds per scoring bucket. */
export const BUCKET_SEC = 5;
/** Chat types a few seconds after what it reacts to. */
export const CHAT_DELAY_SEC = 6;
/** Flagged stretches at least this far apart, so one moment isn't flagged twice. */
export const MIN_SPACING_SEC = 45;
/** Stream openings (waiting screens, "can you hear me") are skipped. */
export const SKIP_START_SEC = 30;

/** Each value's distance from typical, in standard deviations (0 when everything is equal). */
export function zScores(values: number[]): number[] {
  if (!values.length) return [];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return sd > 1e-9 ? values.map((v) => (v - mean) / sd) : values.map(() => 0);
}

/** How far each value rises above the average of the `span` values before it (never negative). */
export function rises(values: number[], span: number): number[] {
  return values.map((v, i) => {
    const before = values.slice(Math.max(0, i - span), i);
    if (!before.length) return 0;
    return Math.max(0, v - before.reduce((a, b) => a + b, 0) / before.length);
  });
}

function bucketize<T>(items: T[], at: (item: T) => number, buckets: number): T[][] {
  const out: T[][] = Array.from({ length: buckets }, () => []);
  for (const item of items) {
    const i = Math.floor(at(item) / BUCKET_SEC);
    if (i >= 0 && i < buckets) out[i].push(item);
  }
  return out;
}

/**
 * Stretches of the stream worth a closer look, strongest first: sudden loudness, chat suddenly
 * busier than usual, chat reacting ("LUL", "clip it", "W"), and the streamer's own reaction words.
 */
export function findCandidates(input: {
  durationSec: number;
  /** Loudness every LOUDNESS_STEP seconds (dB). */
  loudness: number[];
  chat: TimedText[];
  captions: TimedText[];
  max?: number;
}): Candidate[] {
  const { durationSec, loudness, chat, captions, max = MAX_CANDIDATES } = input;
  const n = Math.ceil(durationSec / BUCKET_SEC);
  if (n <= 0) return [];
  const perBucket = Math.round(BUCKET_SEC / LOUDNESS_STEP);

  const loud = Array.from({ length: n }, (_, i) => {
    const slice = loudness.slice(i * perBucket, (i + 1) * perBucket);
    return slice.length ? Math.max(...slice) : -90;
  });
  // Chat shifted back to when the thing it reacts to happened
  const chatBuckets = bucketize(chat, (m) => m.t - CHAT_DELAY_SEC, n);
  const captionBuckets = bucketize(captions, (c) => c.t, n);
  const chatRate = chatBuckets.map((b) => b.length);
  const reactions = chatBuckets.map((b) => reactionHits(b.map((m) => m.text)));
  const speech = captionBuckets.map((b) => b.filter((c) => RECIPES.some((r) => r.speech.test(c.text))).length);

  const zLoud = zScores(rises(loud, 6));
  const hasChat = chat.length > 0;
  const zChat = hasChat ? zScores(rises(chatRate, 12)) : loud.map(() => 0);
  const zReact = hasChat ? zScores(reactions) : loud.map(() => 0);
  const score = loud.map((_, i) => zLoud[i] + 1.2 * zChat[i] + 1.5 * zReact[i] + 0.8 * speech[i]);

  const order = score.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  const picked: Candidate[] = [];
  for (const { s, i } of order) {
    if (picked.length >= max || s <= 0) break;
    // The loudest moment inside the bucket
    const slice = loudness.slice(i * perBucket, (i + 1) * perBucket);
    const offset = slice.length ? slice.indexOf(Math.max(...slice)) * LOUDNESS_STEP : BUCKET_SEC / 2;
    const at = Math.min(durationSec, i * BUCKET_SEC + offset);
    if (at < SKIP_START_SEC) continue;
    if (picked.some((p) => Math.abs(p.at - at) < MIN_SPACING_SEC)) continue;
    const start = Math.max(0, at - WINDOW_BEFORE);
    const end = Math.min(durationSec, at + WINDOW_AFTER);
    const windowChat = chat.filter((m) => m.t >= at - 5 && m.t <= at + 20).map((m) => m.text);
    const windowSpeech = captions.filter((c) => c.t >= start && c.t <= end).map((c) => c.text);
    picked.push({
      at: round(at),
      start: round(start),
      end: round(end),
      score: round(s),
      recipeGuess: guessRecipe(windowChat, windowSpeech),
      chatCount: windowChat.length,
    });
  }
  return picked;
}

const round = (n: number) => Math.round(n * 100) / 100;
