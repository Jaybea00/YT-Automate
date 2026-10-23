/**
 * Style-matched transitions: each style has its own vocabulary of ffmpeg xfade transitions, and
 * each join gets one sized to the moment: mostly cuts or light moves inside a chapter, a bigger
 * one at a chapter change, a special one into a reveal. Never the same move twice in a row, and
 * never longer than the silence at the join, so no spoken word is faded.
 */

export type TransitionIntensity = 'subtle' | 'balanced' | 'bold';
export const TRANSITION_INTENSITIES: TransitionIntensity[] = ['subtle', 'balanced', 'bold'];

interface Vocabulary {
  /** Inside a chapter. */
  light: string[];
  /** At a chapter change. */
  chapter: string[];
  /** Into a reveal. */
  reveal: string[];
  /** Rendered transitions, used first at chapter changes and reveals when switched on. */
  preferred?: { chapter: string[]; reveal: string[] };
}

const DOCUMENTARY: Vocabulary = { light: ['fade', 'dissolve'], chapter: ['fadeblack', 'fadegrays'], reveal: ['fadewhite'] };

const VOCABULARIES: Record<string, Vocabulary> = {
  history: { light: ['fade', 'dissolve'], chapter: ['fadeblack', 'fadegrays'], reveal: ['fadewhite'] },
  cinematic: DOCUMENTARY,
  story_driven: DOCUMENTARY,
  mystery: { light: ['fade', 'dissolve'], chapter: ['fadeblack', 'circleclose'], reveal: ['fadeblack'] },
  true_crime_pov: { light: ['fade', 'fadefast'], chapter: ['fadeblack', 'vertclose'], reveal: ['fadewhite'] },
  sport: { light: ['smoothleft', 'smoothright', 'slideleft'], chapter: ['zoomin', 'squeezeh', 'hblur'], reveal: ['fadewhite'] },
  tech: { light: ['slideleft', 'pixelize', 'wipeleft'], chapter: ['pixelize', 'hlslice', 'squeezev'], reveal: ['hlwind'] },
  tech_review: { light: ['slideleft', 'wipeleft', 'pixelize'], chapter: ['hlslice', 'squeezev', 'pixelize'], reveal: ['zoomin'] },
  vox_explainer: { light: ['slideleft', 'slideup', 'wipeleft'], chapter: ['coverleft', 'revealright'], reveal: ['zoomin'] },
  finance: { light: ['wipeleft', 'slideleft'], chapter: ['wiperight', 'rectcrop'], reveal: ['zoomin'] },
  modernmba: { light: ['wipeleft', 'slideup'], chapter: ['coverleft', 'rectcrop'], reveal: ['zoomin'] },
  comparison: { light: ['wipeleft', 'wiperight'], chapter: ['horzopen', 'vertopen'], reveal: ['zoomin'] },
  space_science: { light: ['fade', 'dissolve'], chapter: ['circleopen', 'fadeblack'], reveal: ['fadewhite'] },
  car: { light: ['smoothleft', 'hblur'], chapter: ['zoomin', 'squeezeh'], reveal: ['fadewhite'] },
  listicle: { light: ['slideleft', 'slideright', 'circleopen'], chapter: ['zoomin', 'circleopen'], reveal: ['fadewhite'] },
  eli5: { light: ['slideleft', 'circleopen', 'slideup'], chapter: ['circleopen', 'zoomin'], reveal: ['fadewhite'] },
};

/** Rendered transitions (custom-transitions.ts) each style uses at chapter changes and into reveals. */
const RENDERED: Record<string, { chapter: string[]; reveal: string[] }> = {
  history: { chapter: ['filmburn'], reveal: ['lightleak'] },
  cinematic: { chapter: ['filmburn', 'lightleak'], reveal: ['lightleak'] },
  story_driven: { chapter: ['lightleak', 'filmburn'], reveal: ['lightleak'] },
  mystery: { chapter: ['filmburn'], reveal: ['flashshake'] },
  true_crime_pov: { chapter: ['glitch', 'filmburn'], reveal: ['flashshake'] },
  sport: { chapter: ['whip', 'zoompunch'], reveal: ['flashshake'] },
  tech: { chapter: ['glitch'], reveal: ['glitch'] },
  tech_review: { chapter: ['glitch', 'zoompunch'], reveal: ['glitch'] },
  vox_explainer: { chapter: ['papertear', 'ink'], reveal: ['zoompunch'] },
  finance: { chapter: ['zoompunch', 'papertear'], reveal: ['zoompunch'] },
  modernmba: { chapter: ['papertear', 'zoompunch'], reveal: ['zoompunch'] },
  comparison: { chapter: ['zoompunch'], reveal: ['zoompunch'] },
  space_science: { chapter: ['lightleak'], reveal: ['lightleak'] },
  car: { chapter: ['whip'], reveal: ['flashshake'] },
  listicle: { chapter: ['zoompunch', 'whip'], reveal: ['flashshake'] },
  eli5: { chapter: ['ink', 'papertear'], reveal: ['zoompunch'] },
};

/**
 * The style's transitions. With `rendered`, chapter changes and reveals lead with the style's
 * rendered transitions (film burn, ink, paper tear, glitch...), alternating with the built-in ones.
 */
export function vocabularyFor(style: string | null | undefined, rendered = false): Vocabulary {
  const base = (style && VOCABULARIES[style]) || DOCUMENTARY;
  const extra = rendered ? (style && RENDERED[style]) || RENDERED.cinematic : null;
  if (!extra) return base;
  return { light: base.light, chapter: [...extra.chapter, ...base.chapter], reveal: [...extra.reveal, ...base.reveal], preferred: extra };
}

/** How often a join inside a chapter gets a move rather than a cut, and how long moves last. */
const INTENSITY = {
  subtle: { every: 6, lightSec: 0.35, chapterSec: 0.6, revealSec: 0.4 },
  balanced: { every: 3, lightSec: 0.45, chapterSec: 0.8, revealSec: 0.5 },
  bold: { every: 2, lightSec: 0.5, chapterSec: 0.9, revealSec: 0.6 },
} satisfies Record<TransitionIntensity, { every: number; lightSec: number; chapterSec: number; revealSec: number }>;

/** Shorter than this, a move reads as a glitch: use a cut. */
export const MIN_MOVE_SEC = 0.2;

export interface Boundary {
  /** The join opens a new chapter. */
  chapter: boolean;
  /** The next beat is a reveal. */
  reveal: boolean;
  /** Silence available at the join (the outgoing tail plus the incoming lead-in). */
  silenceSec: number;
}

export interface PlannedTransition {
  /** An xfade transition name, or "cut". */
  type: string;
  /** Overlap in seconds (0 for a cut). */
  sec: number;
}

/**
 * One transition per join. Deterministic, so re-assembling gives the same edit. A move is cut
 * short to 90% of the join's silence, and dropped for a cut when that's too short.
 */
export function planTransitions(
  boundaries: Boundary[],
  style: string | null | undefined,
  intensity: TransitionIntensity = 'balanced',
  options: { rendered?: boolean } = {},
): PlannedTransition[] {
  const vocab = vocabularyFor(style, options.rendered);
  const level = INTENSITY[intensity] ?? INTENSITY.balanced;
  const out: PlannedTransition[] = [];
  let sinceMove = 0;
  let last = '';
  const pick = (options: string[], seed: number) => {
    const fresh = options.filter((o) => o !== last);
    const pool = fresh.length ? fresh : options;
    return pool[seed % pool.length];
  };
  // Rendered transitions take turns at the big moments; a built-in one steps in only to avoid a repeat
  let turn = 0;
  const pickBig = (preferred: string[] | undefined, fallback: string[], seed: number) => {
    const fresh = (preferred ?? []).filter((o) => o !== last);
    return fresh.length ? fresh[turn++ % fresh.length] : pick(fallback, seed);
  };
  boundaries.forEach((b, i) => {
    let type = 'cut';
    let sec = 0;
    if (b.chapter) {
      type = pickBig(vocab.preferred?.chapter, vocab.chapter, i);
      sec = level.chapterSec;
    } else if (b.reveal) {
      type = pickBig(vocab.preferred?.reveal, vocab.reveal, i);
      sec = level.revealSec;
    } else if (++sinceMove >= level.every) {
      type = pick(vocab.light, i);
      sec = level.lightSec;
    }
    sec = Math.min(sec, Math.round(b.silenceSec * 0.9 * 1000) / 1000);
    if (type === 'cut' || sec < MIN_MOVE_SEC) {
      out.push({ type: 'cut', sec: 0 });
      return;
    }
    sinceMove = 0;
    last = type;
    out.push({ type, sec });
  });
  return out;
}

/** Where each clip starts in the joined video, given each join's overlap. */
export function startsFromOverlaps(durationsSec: number[], overlapsSec: number[]): number[] {
  const starts: number[] = [];
  let t = 0;
  durationsSec.forEach((d, i) => {
    starts.push(t);
    t += d - (overlapsSec[i] ?? 0);
  });
  return starts;
}
