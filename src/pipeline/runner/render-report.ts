import type { PhaseTiming } from './assembly-progress';

/**
 * The render report: how long each step of a render took, what was reused from earlier renders,
 * which encoder made the picture, and what slowed it down. Saved on the video
 * (script_json.render_report) and shown on the progress page.
 */

export interface RenderReport {
  renderedAt: string;
  totalSec: number;
  phases: PhaseTiming[];
  beats: { total: number; rebuilt: number; reused: number };
  /** The joined scenes came from an earlier run that stopped after joining. */
  joinReused: boolean;
  /** Picture encodes in this render, by encoder. */
  encodes: { hardware: number; software: number; fellBack: number };
  endScreenSec: number;
  /** How many problems the final check fixed on its own. */
  fixed: number;
  /** Plain-language notes on what took the time and how to save some. */
  notes: string[];
}

export const formatDuration = (sec: number) => {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

export function buildRenderReport(input: {
  phases: PhaseTiming[];
  totalBeats: number;
  rebuiltBeats: number[] | null;
  joinReused: boolean;
  encodes: { hardware: number; software: number; fellBack: number };
  endScreenSec: number;
  fixed: number;
  hardwareAvailable: boolean;
  now?: Date;
}): RenderReport {
  const { phases, totalBeats, joinReused, encodes, hardwareAvailable } = input;
  const rebuilt = input.rebuiltBeats ? input.rebuiltBeats.length : totalBeats;
  const totalSec = Math.round(phases.reduce((a, p) => a + p.sec, 0) * 10) / 10;
  const notes: string[] = [];
  const slowest = [...phases].sort((a, b) => b.sec - a.sec)[0];
  if (slowest && totalSec > 0) {
    notes.push(`${slowest.label} took the longest: ${formatDuration(slowest.sec)} of ${formatDuration(totalSec)} (${Math.round((slowest.sec / totalSec) * 100)}%).`);
  }
  if (totalBeats > 0) {
    notes.push(
      rebuilt === 0
        ? `All ${totalBeats} beats were reused from the last render.`
        : rebuilt === totalBeats
          ? `All ${totalBeats} beats were built from scratch.`
          : `${rebuilt} of ${totalBeats} beats were rebuilt; the other ${totalBeats - rebuilt} were reused.`,
    );
  }
  if (joinReused) notes.push('The joined scenes were reused from a run that stopped after joining.');
  const join = phases.find((p) => p.phase === 'join');
  if (join && join.sec > 0 && !joinReused) {
    if (encodes.hardware > 0) notes.push(`Joins were encoded on the graphics chip (Quick Sync)${encodes.fellBack ? `; ${encodes.fellBack} fell back to software` : ''}.`);
    else if (!hardwareAvailable) notes.push('No graphics-chip encoder was found, so joins were encoded in software.');
  }
  const master = phases.find((p) => p.phase === 'master');
  if (master && slowest?.phase === 'master') notes.push('Mastering re-encodes the whole picture once for the look, captions and effects; a preview skips most of it.');
  return {
    renderedAt: (input.now ?? new Date()).toISOString(),
    totalSec,
    phases,
    beats: { total: totalBeats, rebuilt, reused: Math.max(0, totalBeats - rebuilt) },
    joinReused,
    encodes,
    endScreenSec: input.endScreenSec,
    fixed: input.fixed,
    notes,
  };
}
