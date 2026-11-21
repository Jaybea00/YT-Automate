/**
 * Contrast Shorts: two sides set against each other, "The problem" vs "The solution", "The myth"
 * vs "The truth", "Before" vs "After", in any niche. Each beat belongs to one side (its
 * contrast_side, "a" or "b"); the side's label sits on screen from the moment it starts, with a
 * quick "VS…" card at each switch. A Series chains several pairs. Browser-safe.
 */

export type ContrastLength = 'quick' | 'story' | 'series';
export type ContrastSide = 'a' | 'b';

export interface ContrastSetup {
  /** The two on-screen labels, e.g. ["The myth", "The truth"]. */
  labels: [string, string];
  length: ContrastLength;
}

/** Label pairs to start from; the creator can type their own. */
export const CONTRAST_PRESETS: Array<[string, string]> = [
  ['The problem', 'The solution'],
  ['The myth', 'The truth'],
  ['Expectation', 'Reality'],
  ['Before', 'After'],
  ['The plan', 'What happened'],
  ['The crime', 'The mistake'],
  ['What most people do', 'What pros do'],
  ['Then', 'Now'],
];

export const CONTRAST_LENGTHS: Array<{ id: ContrastLength; label: string; words: number; note: string }> = [
  { id: 'quick', label: 'Quick · ~15 s', words: 38, note: 'One contrast, a punchline.' },
  { id: 'story', label: 'Story · ~45 s', words: 110, note: 'One contrast with the story behind each side.' },
  { id: 'series', label: 'Series · ~2 min', words: 290, note: 'Several pairs on one theme.' },
];

export const isContrastLength = (v: unknown): v is ContrastLength => v === 'quick' || v === 'story' || v === 'series';

/** A label as typed, tidied: one line, no quotes, at most 30 characters. */
export function cleanLabel(label: unknown): string {
  return String(label ?? '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
}

/** The setup from a request body, or null when it isn't a usable contrast. */
export function contrastSetupFrom(raw: unknown): ContrastSetup | null {
  const r = raw as { labels?: unknown; length?: unknown } | null;
  const labels = Array.isArray(r?.labels) ? r!.labels.map(cleanLabel) : [];
  if (labels.length !== 2 || !labels[0] || !labels[1]) return null;
  return { labels: [labels[0], labels[1]], length: isContrastLength(r?.length) ? r!.length : 'story' };
}

/** Narration length in minutes (about 2.5 words a second). */
export function contrastMinutes(length: ContrastLength): number {
  const words = CONTRAST_LENGTHS.find((l) => l.id === length)!.words;
  return Math.round((words / 2.5 / 60) * 100) / 100;
}

export function contrastShortRules(setup: ContrastSetup): string {
  const [a, b] = setup.labels;
  const len = CONTRAST_LENGTHS.find((l) => l.id === setup.length)!;
  const shape =
    setup.length === 'series'
      ? `- Make 3-5 pairs on one theme. Each pair: its "${a}" beats, then its "${b}" beats. Every pair is its own small reveal; save the strongest pair for last.`
      : setup.length === 'quick'
        ? `- One pair: one short "${a}" beat, then one or two "${b}" beats. It's a punchline: the flip is the whole Short.`
        : `- One pair: the "${a}" side in 1-2 beats, then the "${b}" side in 2-4 beats with the story behind it.`;
  return `THIS IS A CONTRAST SHORT: a vertical video setting "${a}" against "${b}", about ${len.words} spoken words in all.
- Every beat belongs to one side: give each beat "contrast_side": "a" for "${a}" or "b" for "${b}". The labels are shown on screen, so the narration doesn't need to say them.
${shape}
- The first words hook straight into the "${a}" side: no intro, no "in this video". Switch to "${b}" within the first 40% of the Short.
- The "${b}" side is the payoff and gets more time than the "${a}" side. Its last line lands hard.
- Real names, numbers and facts only. No recap and no call to subscribe.`;
}

export interface ContrastSegment {
  /** Position of the beat where this side starts. */
  beat: number;
  side: ContrastSide;
}

/**
 * Where each side starts: a new segment wherever a beat's side changes. Beats with no side follow
 * the beat before them. Without any sides, a single pair is split where the speech is half done
 * (the first side gets the first half); a series without sides has none.
 */
export function contrastSegments(beats: Array<{ text: string; contrast_side?: ContrastSide | null }>, length: ContrastLength = 'story'): ContrastSegment[] {
  if (beats.length < 2) return [];
  const out: ContrastSegment[] = [];
  let current: ContrastSide | null = null;
  beats.forEach((b, i) => {
    const side = b.contrast_side === 'a' || b.contrast_side === 'b' ? b.contrast_side : null;
    if (side && side !== current) {
      out.push({ beat: i, side });
      current = side;
    }
  });
  if (out.some((s) => s.side === 'a') && out.some((s) => s.side === 'b')) {
    // Beats before the first marked side belong to it
    out[0] = { ...out[0], beat: 0 };
    return out;
  }
  if (length === 'series') return [];
  // No sides given: split one pair at the halfway point of the speech
  const words = beats.map((b) => b.text.split(/\s+/).filter(Boolean).length);
  const total = words.reduce((n, w) => n + w, 0);
  let seen = 0;
  let split = 1;
  for (let i = 0; i < beats.length - 1; i++) {
    seen += words[i];
    if (seen >= total * 0.4) {
      split = i + 1;
      break;
    }
  }
  return [
    { beat: 0, side: 'a' },
    { beat: split, side: 'b' },
  ];
}

/** The on-screen card shown for a moment at each switch to the second side. */
export const CONTRAST_SWITCH_CARD = 'VS…';
export const CONTRAST_SWITCH_MS = 700;

/**
 * The labels on top of a contrast Short: each side's label from its first beat, and a quick
 * "VS…" card at each switch to the second side (its label follows the card).
 */
export function contrastBannerLabels(labels: [string, string], segments: ContrastSegment[]): Array<{ text: string; beat: number; offsetMs?: number }> {
  return segments.flatMap((s) => {
    const label = (s.side === 'a' ? labels[0] : labels[1]).toUpperCase();
    return s.side === 'b' && s.beat > 0
      ? [{ text: CONTRAST_SWITCH_CARD, beat: s.beat }, { text: label, beat: s.beat, offsetMs: CONTRAST_SWITCH_MS }]
      : [{ text: label, beat: s.beat }];
  });
}

/** A script marked as a contrast Short of its own (no long video behind it). */
export function asContrastShort<T extends object>(script: T, setup: ContrastSetup, hookBanner?: string | null) {
  return {
    ...script,
    format: 'short' as const,
    contrast: { labels: setup.labels, length: setup.length },
    short: { parent_video_id: null, hook_banner: (hookBanner || (script as { title_options?: string[] }).title_options?.[0] || '').trim() },
    // Shorts move fast: no extra pause between beats
    beat_pause_seconds: 0,
  };
}
