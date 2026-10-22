import type { ScriptBeat } from './generate-script';
import { SPEECH_WORDS_PER_SECOND } from './script-quality';

/**
 * Visual rhythm ("slideshow risk"): how varied the picture is across the whole video. A plan can
 * pass every per-beat rule and still play as an animated slide deck: stat, text card, stat,
 * text card. This scores the shot sequence across beats and names what makes it repetitive.
 * The shot planner uses it to repair a plan before rendering; the visuals stage uses it to
 * report on what was actually rendered, after any fallbacks.
 */

/** How a viewer perceives a shot. */
export type ShotKind = 'footage' | 'graphic' | 'text' | 'blank';

const FOOTAGE_TYPES = new Set(['stock', 'archive', 'screen_recording']);
const TEXT_TYPES = new Set(['kinetic_text', 'title']);

export function kindOf(type: string): ShotKind {
  if (FOOTAGE_TYPES.has(type)) return 'footage';
  if (TEXT_TYPES.has(type)) return 'text';
  if (type === 'color') return 'blank';
  return 'graphic';
}

/** Graphics or text in a row before footage has to break them up. */
export const MAX_NON_FOOTAGE_RUN = 2;
export const MAX_SAME_TYPE_RUN = 2;
/** Within any DENSITY_WINDOW consecutive shots, one graphic type appears at most this often. */
export const DENSITY_WINDOW = 8;
export const MAX_SAME_TYPE_IN_WINDOW = 2;
/** Maps follow the places the story visits; a travel story legitimately needs many. */
export const DENSITY_EXEMPT = new Set(['geo_map']);
/** Share of shots that may be text cards (kinetic text and chapter titles). */
export const MAX_TEXT_SHARE = 0.12;
/** Share of screen time that may be graphics and text rather than footage. */
export const MAX_GRAPHICS_SHARE = 0.55;
/** Neighbouring footage searches this similar (shared words) show the same thing twice. */
const SIMILAR_QUERY = 0.6;
const QUERY_LOOKBACK = 3;
/** Still photos in a row (each with a slow camera move) read as a slideshow. */
const MAX_STILL_RUN = 2;

export type RhythmRule =
  | 'non_footage_run'
  | 'same_type_run'
  | 'type_density'
  | 'text_overuse'
  | 'graphics_share'
  | 'repeated_footage'
  | 'still_run'
  | 'fallback';

const RULE_WEIGHT: Record<RhythmRule, number> = {
  non_footage_run: 8,
  same_type_run: 8,
  type_density: 5,
  text_overuse: 6,
  graphics_share: 10,
  repeated_footage: 4,
  still_run: 5,
  fallback: 6,
};

export interface RhythmShot {
  beat: number;
  /** Position within the beat. */
  shot: number;
  type: string;
  seconds: number;
  /** Search phrase, for footage. */
  query?: string;
  /** Rendered from a still photo rather than moving footage (known after rendering; undefined when not recorded). */
  still?: boolean;
  /** Rendered as something other than planned because the plan couldn't be filled. */
  fallback?: boolean;
}

export interface RhythmIssue {
  rule: RhythmRule;
  beat: number;
  shot: number;
  message: string;
  /** Repaired automatically (the plan was changed). */
  fixed?: boolean;
}

export interface RhythmReport {
  stage: 'plan' | 'render';
  /** 0-100; higher is more varied. Counts only issues that remain. */
  score: number;
  risk: 'low' | 'medium' | 'high';
  shots: number;
  /** Shares of screen time. */
  footageShare: number;
  graphicsShare: number;
  /** Share of shots that are text cards. */
  textShare: number;
  /** Share of footage shots that are still photos (render stage only). */
  stillShare?: number;
  longestNonFootageRun: number;
  issues: RhythmIssue[];
  checkedAt: string;
}

const tokens = (s = '') =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 2),
  );

export function querySimilarity(a = '', b = ''): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / Math.min(ta.size, tb.size);
}

/** The planned shots of a script in viewing order, timed from their word counts. */
export function planToRhythmShots(beats: ScriptBeat[]): RhythmShot[] {
  return beats.flatMap((beat) =>
    (beat.shots ?? []).map((shot, i) => ({
      beat: beat.index,
      shot: i,
      type: shot.visual_type,
      seconds: shot.word_count / SPEECH_WORDS_PER_SECOND,
      query: kindOf(shot.visual_type) === 'footage' ? shot.visual_query : undefined,
    })),
  );
}

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) / 100 : 0);
const at = (s: RhythmShot) => `Beat ${s.beat + 1}, shot ${s.shot + 1}`;

/** Finds what makes a shot sequence repetitive. Issues already repaired can be passed in to be listed. */
export function analyzeRhythm(
  shots: RhythmShot[],
  stage: RhythmReport['stage'],
  fixed: RhythmIssue[] = [],
  /** The style's graphics limit (style packs may set their own). */
  maxGraphicsShare: number = MAX_GRAPHICS_SHARE,
): RhythmReport {
  const issues: RhythmIssue[] = [];
  let nonFootageRun = 0;
  let longestNonFootageRun = 0;
  let sameRun = 0;
  let stillRun = 0;

  shots.forEach((s, i) => {
    const kind = kindOf(s.type);
    const prev = shots[i - 1];

    nonFootageRun = kind === 'footage' ? 0 : nonFootageRun + 1;
    longestNonFootageRun = Math.max(longestNonFootageRun, nonFootageRun);
    if (nonFootageRun === MAX_NON_FOOTAGE_RUN + 1) {
      issues.push({ rule: 'non_footage_run', beat: s.beat, shot: s.shot, message: `${at(s)}: ${nonFootageRun} graphics or text cards in a row with no footage between` });
    }

    sameRun = prev && prev.type === s.type && kind !== 'footage' ? sameRun + 1 : 1;
    if (kind !== 'footage' && sameRun === MAX_SAME_TYPE_RUN + 1) {
      issues.push({ rule: 'same_type_run', beat: s.beat, shot: s.shot, message: `${at(s)}: ${sameRun} "${s.type}" shots in a row` });
    }

    if ((kind === 'graphic' || s.type === 'kinetic_text') && !DENSITY_EXEMPT.has(s.type)) {
      const window = shots.slice(Math.max(0, i - DENSITY_WINDOW + 1), i + 1);
      const count = window.filter((w) => w.type === s.type).length;
      // Report once per crowded stretch: when this shot is the one that tips it over
      if (count === MAX_SAME_TYPE_IN_WINDOW + 1) {
        issues.push({ rule: 'type_density', beat: s.beat, shot: s.shot, message: `${at(s)}: ${count} "${s.type}" shots within ${window.length} shots` });
      }
    }

    if (kind === 'footage' && s.query) {
      const earlier = shots.slice(0, i).filter((p) => kindOf(p.type) === 'footage' && p.query).slice(-QUERY_LOOKBACK);
      const twin = earlier.find((p) => querySimilarity(p.query, s.query) >= SIMILAR_QUERY);
      if (twin) {
        issues.push({ rule: 'repeated_footage', beat: s.beat, shot: s.shot, message: `${at(s)}: footage searched almost the same as ${at(twin)} ("${s.query}")` });
      }
    }

    stillRun = kind === 'footage' && s.still ? stillRun + 1 : 0;
    if (stillRun === MAX_STILL_RUN + 1) {
      issues.push({ rule: 'still_run', beat: s.beat, shot: s.shot, message: `${at(s)}: ${stillRun} still photos in a row` });
    }

    if (s.fallback) {
      issues.push({
        rule: 'fallback',
        beat: s.beat,
        shot: s.shot,
        message: kind === 'blank' ? `${at(s)}: couldn't be rendered (plain background)` : `${at(s)}: planned footage wasn't found, shown as ${s.type.replace('_', ' ')}`,
      });
    }
  });

  const totalSeconds = shots.reduce((n, s) => n + s.seconds, 0);
  const footageSeconds = shots.filter((s) => kindOf(s.type) === 'footage').reduce((n, s) => n + s.seconds, 0);
  const graphicsShare = share(totalSeconds - footageSeconds, totalSeconds);
  const textShots = shots.filter((s) => kindOf(s.type) === 'text').length;
  const textShare = share(textShots, shots.length);
  const allowedText = Math.max(1, Math.floor(shots.length * MAX_TEXT_SHARE));
  if (textShots > allowedText) {
    issues.push({ rule: 'text_overuse', beat: -1, shot: -1, message: `${textShots} text cards (${Math.round(textShare * 100)}% of shots); aim for ${allowedText} or fewer` });
  }
  if (graphicsShare > maxGraphicsShare) {
    issues.push({ rule: 'graphics_share', beat: -1, shot: -1, message: `Graphics and text fill ${Math.round(graphicsShare * 100)}% of the video; aim for ${Math.round(maxGraphicsShare * 100)}% or less` });
  }

  // Only shots that recorded whether they were stills (older renders didn't) count
  const footageKnown = shots.filter((s) => kindOf(s.type) === 'footage' && s.still !== undefined);
  const stillShare = stage === 'render' && footageKnown.length ? share(footageKnown.filter((s) => s.still).length, footageKnown.length) : undefined;
  const score = Math.max(0, 100 - issues.reduce((n, issue) => n + RULE_WEIGHT[issue.rule], 0));

  return {
    stage,
    score,
    risk: score >= 80 ? 'low' : score >= 60 ? 'medium' : 'high',
    shots: shots.length,
    footageShare: share(footageSeconds, totalSeconds),
    graphicsShare,
    textShare,
    ...(stillShare !== undefined ? { stillShare } : {}),
    longestNonFootageRun,
    issues: [...fixed.map((f) => ({ ...f, fixed: true })), ...issues],
    checkedAt: new Date().toISOString(),
  };
}
