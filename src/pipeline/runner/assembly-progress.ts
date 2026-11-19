import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * How far an assembly has got, written to <job folder>/progress.json as it runs, so the progress
 * page can show a percentage, the step by name and the time left. Each step's share of the bar is
 * roughly its share of the time on a small laptop (a 10-minute video: scenes ~15%, joining ~35%,
 * music and sound ~7%, mastering ~40%). Time left comes from the speed so far in this run, so a
 * resumed run (its scenes already rendered) starts further along and estimates from there.
 */

export type AssemblyPhase = 'scenes' | 'join' | 'music' | 'sound' | 'master' | 'check';

const PHASES: Array<{ id: AssemblyPhase; label: string; weight: number }> = [
  { id: 'scenes', label: 'Rendering scenes', weight: 0.16 },
  { id: 'join', label: 'Joining scenes', weight: 0.35 },
  { id: 'music', label: 'Adding music', weight: 0.05 },
  { id: 'sound', label: 'Adding sound effects', weight: 0.02 },
  { id: 'master', label: 'Mastering (look, captions, loudness)', weight: 0.4 },
  { id: 'check', label: 'Final quality check', weight: 0.02 },
];

export interface AssemblyProgress {
  phase: AssemblyPhase;
  label: string;
  /** 0-100. */
  percent: number;
  detail?: string;
  /** Estimated seconds left, once enough of this run has gone by to judge. */
  etaSec?: number;
  startedAt: string;
  updatedAt: string;
}

export interface PhaseTiming {
  phase: AssemblyPhase;
  label: string;
  sec: number;
}

/**
 * Each step's time: from when it began to when the next began (the last to `now`). Time before
 * the first step (loading, planning) counts toward the first.
 */
export function phaseTimings(startedAt: number, starts: Array<{ phase: AssemblyPhase; at: number }>, now: number): PhaseTiming[] {
  return starts.map((s, i) => ({
    phase: s.phase,
    label: PHASES.find((p) => p.id === s.phase)?.label ?? s.phase,
    sec: Math.max(0, Math.round(((starts[i + 1]?.at ?? now) - (i === 0 ? startedAt : s.at)) / 100) / 10),
  }));
}

export const progressFilePath = (jobDir: string) => path.join(jobDir, 'progress.json');

/** The overall fraction (0-1) at `fraction` of the way through `phase`. */
export function overallFraction(phase: AssemblyPhase, fraction: number): number {
  let before = 0;
  for (const p of PHASES) {
    if (p.id === phase) return Math.min(1, before + p.weight * Math.max(0, Math.min(1, fraction)));
    before += p.weight;
  }
  return before;
}

/** Seconds left at `done` (0-1) after `elapsedSec`, having started this run at `startFraction`. */
export function estimateSecondsLeft(done: number, startFraction: number, elapsedSec: number): number | undefined {
  const progressed = done - startFraction;
  // Too early to judge: the first few percent of a run are dominated by setup
  if (progressed < 0.03 || elapsedSec < 60) return undefined;
  return Math.max(0, Math.round((elapsedSec * (1 - done)) / progressed));
}

export class AssemblyProgressTracker {
  private readonly started = Date.now();
  private startFraction: number | null = null;
  private lastWrite = 0;
  private current: { phase: AssemblyPhase; fraction: number; detail?: string } = { phase: 'scenes', fraction: 0 };
  /** When each step began, in the order they ran (for the render report). */
  private readonly phaseStarts: Array<{ phase: AssemblyPhase; at: number }> = [];

  constructor(private readonly file: string) {}

  /** Moves to `fraction` (0-1) of `phase`; written at most every couple of seconds unless `force`. */
  async set(phase: AssemblyPhase, fraction: number, detail?: string, force = false): Promise<void> {
    this.current = { phase, fraction, detail };
    if (!this.phaseStarts.some((p) => p.phase === phase)) this.phaseStarts.push({ phase, at: Date.now() });
    const done = overallFraction(phase, fraction);
    // The first report fixes where this run began (a resumed run starts past its reused scenes)
    if (this.startFraction === null && (phase !== 'scenes' || fraction > 0)) this.startFraction = done;
    const now = Date.now();
    if (!force && now - this.lastWrite < 2000) return;
    this.lastWrite = now;
    const label = PHASES.find((p) => p.id === phase)?.label ?? phase;
    const etaSec = estimateSecondsLeft(done, this.startFraction ?? 0, (now - this.started) / 1000);
    const progress: AssemblyProgress = {
      phase,
      label,
      percent: Math.round(done * 1000) / 10,
      ...(detail ? { detail } : {}),
      ...(etaSec !== undefined ? { etaSec } : {}),
      startedAt: new Date(this.started).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    await fs.mkdir(path.dirname(this.file), { recursive: true }).catch(() => {});
    await fs.writeFile(this.file, JSON.stringify(progress), 'utf-8').catch(() => {});
  }

  /** Re-writes the current position (keeps "updated" fresh during a long single step). */
  async touch(): Promise<void> {
    await this.set(this.current.phase, this.current.fraction, this.current.detail, true);
  }

  /** How long each step took so far, in the order they ran. */
  timings(now = Date.now()): PhaseTiming[] {
    return phaseTimings(this.started, this.phaseStarts, now);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true }).catch(() => {});
  }
}

/**
 * Follows an ffmpeg `-progress` file during a long encode, reporting the fraction of
 * `totalSec` done. Returns a stop function.
 */
export function followFfmpegProgress(progressFile: string, totalSec: number, onFraction: (fraction: number) => void, everyMs = 3000): () => void {
  const timer = setInterval(async () => {
    const text = await fs.readFile(progressFile, 'utf-8').catch(() => '');
    // The file grows by blocks; the last out_time_us is the furthest point encoded
    const matches = [...text.matchAll(/out_time_us=(\d+)/g)];
    const us = Number(matches[matches.length - 1]?.[1] ?? 0);
    if (us > 0 && totalSec > 0) onFraction(Math.min(1, us / 1e6 / totalSec));
  }, everyMs);
  return () => clearInterval(timer);
}
