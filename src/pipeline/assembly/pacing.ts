/**
 * Pacing between beats, read from the script rather than one fixed pause:
 * - every beat opens with a short lead-in: the picture cuts a moment before the voice, so the
 *   eye arrives first (as documentary editors cut);
 * - flowing lines follow each other closely, a question or a punchy line gets room to land,
 *   and a change of section gets the longest gap, with a dip to black inside it.
 * The video's "pause between beats" setting scales all of it.
 */

export interface Section {
  /** Index of the beat the section starts on. */
  start_beat: number;
  title: string;
}

export interface BeatPacing {
  /** Picture (and silence) before the narration starts. */
  leadInSec: number;
  /** Picture (and silence) after the narration ends. */
  tailSec: number;
  /** Fade from black over the lead-in (this beat opens a section). */
  dipIn: boolean;
  /** Fade to black over the tail (the next beat opens a section). */
  dipOut: boolean;
}

export const DEFAULT_BEAT_PAUSE_SEC = 0.5;
const MAX_LEAD_IN_SEC = 0.25;
/** Lines this short read as punchy and get room to land. */
const PUNCHY_WORDS = 8;

const round = (n: number) => Math.round(n * 1000) / 1000;

/** A line that should land: a question, an exclamation, a trailing thought, or a short punch. */
export function isLandingLine(text: string): boolean {
  const t = text.trim();
  return /[?!]["”’']?$/.test(t) || /(\.\.\.|…)["”’']?$/.test(t) || t.split(/\s+/).filter(Boolean).length <= PUNCHY_WORDS;
}

/**
 * Lead-in and tail for every beat. `beats` are in playback order; `sections` mark where new
 * sections (chapters) start.
 */
export function planPacing(
  beats: Array<{ index: number; text: string }>,
  sections: Section[],
  basePauseSec: number = DEFAULT_BEAT_PAUSE_SEC,
): Map<number, BeatPacing> {
  const base = Math.max(0, Math.min(3, Number.isFinite(basePauseSec) ? basePauseSec : DEFAULT_BEAT_PAUSE_SEC));
  const sectionStarts = new Set(sections.map((s) => s.start_beat).filter((b) => b > 0));
  const plan = new Map<number, BeatPacing>();
  if (base === 0) {
    for (const b of beats) plan.set(b.index, { leadInSec: 0, tailSec: 0, dipIn: false, dipOut: false });
    return plan;
  }

  const lead = Math.min(MAX_LEAD_IN_SEC, base * 0.4);
  const sectionLead = base * 1.2;
  beats.forEach((beat, pos) => {
    const next = beats[pos + 1];
    const opensSection = pos > 0 && sectionStarts.has(beat.index);
    const nextOpensSection = Boolean(next && sectionStarts.has(next.index));
    const leadInSec = opensSection ? sectionLead : lead;

    let tailSec: number;
    if (!next) tailSec = Math.min(1.5, base * 2.4); // the ending breathes before the fade
    else if (nextOpensSection) tailSec = base * 1.2;
    else if (isLandingLine(beat.text)) tailSec = base * 1.3 - lead;
    else tailSec = Math.max(0.08, base * 0.6 - lead);

    plan.set(beat.index, {
      leadInSec: round(leadInSec),
      tailSec: round(Math.max(0, tailSec)),
      dipIn: opensSection,
      dipOut: nextOpensSection,
    });
  });
  return plan;
}

/** What the retention check (stage 2) saw in a beat, as pacing needs it. */
export interface BeatInterest {
  beat_index: number;
  /** 1 (skippable) to 5 (can't look away). */
  interest: number;
  pattern_break?: boolean;
}

/** How much shorter the pause after a dull beat gets, and how much longer after a gripping one. */
const DULL_TAIL = 0.5;
const GRIPPING_TAIL = 1.25;
const MAX_EXTRA_SEC = 0.3;

/**
 * Pauses tightened from the retention check: after a beat viewers would skip (interest 1-2, or a
 * "dead beat" the check flagged) the next line comes sooner; after a gripping one (interest 5 or
 * a turn in the story) it gets a little more room to land. Section changes keep their gaps and
 * dips, and lead-ins are untouched (the picture still arrives before the voice).
 */
export function tightenFromRetention(
  plan: Map<number, BeatPacing>,
  retention: { marks?: BeatInterest[]; issues?: Array<{ beat_index: number; kind: string; dismissed?: boolean }> } | null | undefined,
): { plan: Map<number, BeatPacing>; tightened: number[]; loosened: number[] } {
  const tightened: number[] = [];
  const loosened: number[] = [];
  if (!retention?.marks?.length) return { plan, tightened, loosened };
  const dead = new Set((retention.issues ?? []).filter((i) => i.kind === 'dead_beat' && !i.dismissed).map((i) => i.beat_index));
  const marks = new Map(retention.marks.map((m) => [m.beat_index, m]));
  const out = new Map<number, BeatPacing>();
  const last = Math.max(...plan.keys());
  for (const [index, p] of plan) {
    const m = marks.get(index);
    // Section changes and the ending keep their timing
    if (!m || p.dipOut || index === last || p.tailSec <= 0) {
      out.set(index, p);
      continue;
    }
    if (dead.has(index) || m.interest <= 2) {
      out.set(index, { ...p, tailSec: round(Math.max(0.08, p.tailSec * DULL_TAIL)) });
      tightened.push(index);
    } else if (m.interest >= 5 || m.pattern_break) {
      out.set(index, { ...p, tailSec: round(Math.min(p.tailSec + MAX_EXTRA_SEC, p.tailSec * GRIPPING_TAIL)) });
      loosened.push(index);
    } else {
      out.set(index, p);
    }
  }
  return { plan: out, tightened, loosened };
}

/**
 * The video's pacing: the script's rhythm, scaled by its pause setting, then tightened from the
 * retention check unless that's turned off (script_json.pacing_from_retention === false). Visuals
 * and assembly both plan with this, so composed tracks and the final cut agree.
 */
export function videoPacing(
  beats: Array<{ index: number; text: string }>,
  sections: Section[],
  scriptJson: { beat_pause_seconds?: unknown; pacing_from_retention?: unknown; retention?: unknown } | null | undefined,
): Map<number, BeatPacing> {
  const base = planPacing(beats, sections, Number(scriptJson?.beat_pause_seconds ?? DEFAULT_BEAT_PAUSE_SEC));
  if (scriptJson?.pacing_from_retention === false) return base;
  const retention = scriptJson?.retention as (Parameters<typeof tightenFromRetention>[1] & { beatsChecked?: number }) | undefined;
  // A check made before beats were added or removed no longer lines up with them
  if (!retention || retention.beatsChecked !== beats.length) return base;
  return tightenFromRetention(base, retention).plan;
}
