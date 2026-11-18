import { wordBudgetForMinutes } from './script-quality';

/**
 * The new-video page's runtime presets and its rough "how long will this take" estimate.
 * Client-safe (no server imports).
 */

export interface RuntimePreset {
  id: string;
  minutes: number;
  label: string;
  note: string;
}

/** YouTube shows mid-roll ads only on videos of 8:00 or longer. */
export const MID_ROLL_MINUTES = 8;

export const RUNTIME_PRESETS: RuntimePreset[] = [
  { id: 'one', minutes: 1, label: '~1 min', note: 'A quick one. For a vertical Short, make it from a finished video on its Publish page.' },
  { id: 'five', minutes: 5, label: '~5 min', note: 'Quick takes and single ideas.' },
  { id: 'midroll', minutes: 8.5, label: '8½ min', note: 'Mid-roll ads need 8:00 or longer; 8½ leaves a margin so the final cut doesn’t fall short.' },
  { id: 'ten', minutes: 10, label: '10 min', note: 'A solid explainer or story, past the mid-roll line.' },
  { id: 'deep', minutes: 12, label: '12 min', note: 'A full deep dive.' },
  { id: 'fifteen', minutes: 15, label: '15 min', note: 'A long story or investigation.' },
  { id: 'long', minutes: 20, label: '20 min', note: 'Long-form documentary.' },
];

export function presetFor(minutes: number): RuntimePreset | undefined {
  return RUNTIME_PRESETS.find((p) => Math.abs(p.minutes - minutes) < 0.01);
}

/** A one-line note on a custom length, when there's something worth knowing. */
export function runtimeNote(minutes: number): string | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes >= 7 && minutes < MID_ROLL_MINUTES + 0.25) {
    return `Mid-roll ads need 8:00 or longer. Aim for at least ${MID_ROLL_MINUTES + 0.5} minutes so the final cut doesn't fall short.`;
  }
  return presetFor(minutes)?.note ?? null;
}

export interface CreationEstimate {
  /** About how many calls to the writing model. */
  aiCalls: number;
  /** Rough wall-clock minutes, low and high. */
  minutesLow: number;
  minutesHigh: number;
  /** Narration words the script aims for. */
  words: number;
}

/**
 * Roughly how long research and writing take. The ranges are wide on purpose: the model, its
 * speed and how many length passes a script needs all vary.
 */
export function estimateCreation(input: {
  mode: 'ai' | 'raw_ai';
  minutes: number;
  /** With a brief, writing stops at an outline for you to approve. */
  withBrief?: boolean;
  /** The style's narration pace (documentary styles say fewer words per minute). */
  paceFactor?: number;
  /** Several topics are written one after another. */
  count?: number;
}): CreationEstimate {
  const count = Math.max(1, Math.round(input.count ?? 1));
  const minutes = Math.max(0.5, input.minutes || 0.5);
  const budget = wordBudgetForMinutes(minutes, input.paceFactor ?? 1);
  const beats = budget.targetBeats;
  const shotBatches = Math.ceil(beats / 12);
  let calls: number;
  let low: number;
  let high: number;
  if (input.mode === 'raw_ai') {
    calls = 1 + shotBatches;
    low = 0.3 + minutes * 0.04;
    high = 1 + minutes * 0.12;
  } else if (input.withBrief) {
    // research (3) + packaging + outline
    calls = 5;
    low = 0.7;
    high = 2.5;
  } else {
    // research (3) + packaging + script (+ up to 2 length passes) + shots + fact, pronunciation and ad checks
    const checkCalls = 2 * Math.ceil(beats / 60) + 1;
    calls = 3 + 1 + 2 + shotBatches + checkCalls;
    low = 0.8 + minutes * 0.12;
    high = 2 + minutes * 0.4;
  }
  const round = (n: number) => Math.max(1, Math.round(n));
  return { aiCalls: calls * count, minutesLow: round(low * count), minutesHigh: round(high * count), words: budget.target };
}

export function describeEstimate(e: CreationEstimate): string {
  const time = e.minutesLow === e.minutesHigh ? `~${e.minutesLow} min` : `~${e.minutesLow}–${e.minutesHigh} min`;
  return `About ${e.aiCalls} AI calls · ${time} in the background`;
}
