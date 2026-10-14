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
