/**
 * Retention check types and the rules measured from the script itself, safe to use in the browser.
 * The model marks what each beat does (retention.ts); these rules turn the marks and the timings
 * into the problems that make viewers leave.
 */
import { estimateSpeechSeconds } from './script-quality';

export const RETENTION_KINDS = [
  'slow_start',
  'dead_beat',
  'no_open_loop',
  'missing_rehook',
  'no_pattern_break',
  'promise_unpaid',
  'early_payoff',
] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

export const RETENTION_KIND_LABEL: Record<RetentionKind, string> = {
  slow_start: 'Slow start',
  dead_beat: 'Dead beat',
  no_open_loop: 'Nothing to stay for',
  missing_rehook: 'No re-hook',
  no_pattern_break: 'No change of pace',
  promise_unpaid: 'Promise not paid off',
  early_payoff: 'Payoff too early',
};

/** What each kind means, for the panel's help text. */
export const RETENTION_KIND_HELP: Record<RetentionKind, string> = {
  slow_start: 'The first seconds don\'t grab attention or raise a question.',
  dead_beat: 'No new information, no stakes, nothing moving: the beat viewers skip.',
  no_open_loop: 'A long stretch where no question is waiting to be answered.',
  missing_rehook: 'A new section starts without giving a reason to keep watching.',
  no_pattern_break: 'A long stretch at the same pace with no surprise, question or turn.',
  promise_unpaid: 'The video never delivers what the title and hook promised.',
  early_payoff: 'The main question is answered so early that viewers can leave.',
};

export type RetentionSeverity = 'high' | 'medium';

/** What the model saw in one beat. */
export interface BeatMarks {
  beat_index: number;
  /** How gripping the beat is, 1 (skippable) to 5 (can't look away). */
  interest: number;
  new_info: boolean;
  stakes: boolean;
  /** A change of pace: a surprise, a question to the viewer, a turn in the story, a new section. */
  pattern_break: boolean;
  /** Set when a new section starts here: its short name. */
  section_start: string | null;
  /** At a section start: whether it gives a fresh reason to keep watching. */
  rehook: boolean;
}

/** A question raised for the viewer and where it is answered (null: never). */
export interface OpenLoop {
  question: string;
  opened_at: number;
  closed_at: number | null;
}

export interface PromiseCheck {
  /** What the title / hook promises, in a sentence. */
  promise: string;
  status: 'paid' | 'partial' | 'unpaid';
  /** The beat where it is paid off. */
  paid_at: number | null;
  note: string;
}

export interface RetentionIssue {
  id: string;
  beat_index: number;
  kind: RetentionKind;
  severity: RetentionSeverity;
  problem: string;
  /** Instruction for the beat rewriter. */
  fix_instruction: string;
  /** The whole beat rewritten, when the model wrote one. */
  suggested_text?: string;
  checked_text: string;
  dismissed?: boolean;
}

export interface RetentionReport {
  checkedAt: string;
  model?: string;
  beatsChecked: number;
  /** Where each beat starts, in seconds of narration. */
  starts: number[];
  totalSeconds: number;
  /** 0-100, an estimate from the beats' interest and the problems found. */
  score: number;
  marks: BeatMarks[];
  loops: OpenLoop[];
  promise: PromiseCheck | null;
  issues: RetentionIssue[];
}

/** A pause between beats, as the voicing adds. */
const BEAT_PAUSE_SECONDS = 0.5;

/** Where each beat starts and how long the narration runs, in seconds. */
export function beatTimeline(beats: Array<{ text: string }>): { starts: number[]; totalSeconds: number } {
  const starts: number[] = [];
  let t = 0;
  for (const b of beats) {
    starts.push(Math.round(t * 10) / 10);
    t += estimateSpeechSeconds(b.text) + BEAT_PAUSE_SECONDS;
  }
  return { starts, totalSeconds: Math.round(t * 10) / 10 };
}

/** Pace rules scale with length: a Short needs a change every few seconds, a long video every minute. */
export function paceLimits(totalSeconds: number): { breakEvery: number; loopGap: number } {
  return totalSeconds <= 90 ? { breakEvery: 15, loopGap: 20 } : { breakEvery: 60, loopGap: 90 };
}

type LocalIssue = Omit<RetentionIssue, 'id' | 'checked_text' | 'suggested_text'>;

/**
 * The problems the timings and the model's marks prove. Each comes with an instruction the beat
 * rewriter can follow.
 */
export function measuredIssues(input: {
  starts: number[];
  totalSeconds: number;
  marks: BeatMarks[];
  loops: OpenLoop[];
  promise: PromiseCheck | null;
}): LocalIssue[] {
  const { starts, totalSeconds, marks, loops, promise } = input;
  const n = starts.length;
  if (!n) return [];
  const mark = (i: number) => marks.find((m) => m.beat_index === i);
  const { breakEvery, loopGap } = paceLimits(totalSeconds);
  const issues: LocalIssue[] = [];
  const at = (i: number) => (i >= n ? totalSeconds : starts[i]);
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // Slow start: a weak hook, or no question raised in the first two beats
  const hook = mark(0);
  const earlyLoop = loops.some((l) => l.opened_at <= 1);
  if ((hook && hook.interest < 4) || !earlyLoop) {
    issues.push({
      beat_index: 0,
      kind: 'slow_start',
      severity: 'high',
      problem: hook && hook.interest < 4 ? 'The hook is not gripping enough to stop the scroll.' : 'The opening doesn\'t raise a question the viewer wants answered.',
      fix_instruction: 'Rewrite the hook to open on the most surprising fact or mid-action and raise one clear question the video will answer. Under 25 words, no introduction.',
    });
  }

  // Dead beats, reported once per run
  for (let i = 1; i < n; i++) {
    const isDead = (k: number) => {
      const m = mark(k);
      return Boolean(m && m.interest <= 2 && !m.new_info && !m.stakes);
    };
    if (!isDead(i) || isDead(i - 1)) continue;
    let run = 1;
    while (i + run < n && isDead(i + run)) run++;
    issues.push({
      beat_index: i,
      kind: 'dead_beat',
      severity: run >= 2 ? 'high' : 'medium',
      problem: run >= 2 ? `${run} beats in a row add nothing new (about ${Math.round(at(i + run) - at(i))}s), so viewers start skipping.` : 'This beat adds no new information or stakes.',
      fix_instruction: 'Rewrite this beat so it adds a new fact, raises the stakes, or moves the story forward. Cut filler and repetition; keep it short.',
    });
  }

  // Sections that start without a re-hook
  for (const m of marks) {
    if (m.beat_index > 0 && m.beat_index < n && m.section_start && !m.rehook) {
      issues.push({
        beat_index: m.beat_index,
        kind: 'missing_rehook',
        severity: 'medium',
        problem: `The "${m.section_start}" section starts without a fresh reason to keep watching.`,
        fix_instruction: 'Open this section with a re-hook: a question, a surprising turn, or a teaser of what is coming, before the explanation.',
      });
    }
  }

  // Too long without a change of pace
  let lastBreak = 0;
  for (let i = 1; i < n; i++) {
    if (mark(i)?.pattern_break) {
      lastBreak = at(i);
      continue;
    }
    if (at(i) - lastBreak > breakEvery) {
      issues.push({
        beat_index: i,
        kind: 'no_pattern_break',
        severity: 'medium',
        problem: `About ${Math.round(at(i) - lastBreak)}s at the same pace since the last surprise, question or turn.`,
        fix_instruction: 'Add a change of pace in this beat: a surprising fact, a direct question to the viewer, a contrast, or a turn in the story.',
      });
      lastBreak = at(i);
    }
  }

  // Stretches where no question is waiting to be answered (after the hook, before the ending)
  const covered = (t: number) => loops.some((l) => at(l.opened_at) <= t && t < (l.closed_at == null ? totalSeconds : at(l.closed_at)));
  const endZone = totalSeconds * 0.9;
  let gapStart: number | null = null;
  for (let i = 1; i < n; i++) {
    const t = at(i);
    if (t >= endZone) break;
    if (!covered(t)) {
      gapStart ??= i;
      const gapLen = at(i + 1) - at(gapStart);
      if (gapLen > loopGap && !issues.some((x) => x.kind === 'no_open_loop' && x.beat_index === gapStart)) {
        issues.push({
          beat_index: gapStart,
          kind: 'no_open_loop',
          severity: 'high',
          problem: `From ${clock(at(gapStart))} there's no open question for about ${Math.round(gapLen)}s, so nothing keeps the viewer waiting.`,
          fix_instruction: 'Raise a question here that is answered a little later ("but that was not the strangest part…"), without giving the answer yet.',
        });
      }
    } else {
      gapStart = null;
    }
  }

  // The promise of the title and hook
  if (promise) {
    if (promise.status === 'unpaid' || promise.status === 'partial') {
      issues.push({
        beat_index: n - 1,
        kind: 'promise_unpaid',
        severity: promise.status === 'unpaid' ? 'high' : 'medium',
        problem: `${promise.status === 'unpaid' ? 'The video never delivers' : 'The video only partly delivers'} what the title promises: ${promise.promise}${promise.note ? ` (${promise.note})` : ''}`,
        fix_instruction: `Make the ending clearly deliver the promise: ${promise.promise}. Give the answer plainly, then one closing line.`,
      });
    } else if (promise.paid_at != null && totalSeconds > 120 && at(promise.paid_at) < totalSeconds * 0.25) {
      issues.push({
        beat_index: promise.paid_at,
        kind: 'early_payoff',
        severity: 'medium',
        problem: `The main question is answered at ${clock(at(promise.paid_at))}, in the first quarter, so viewers can leave satisfied.`,
        fix_instruction: 'Hold back the full answer: hint at it here and open a bigger question, then deliver the complete payoff near the end.',
      });
    }
  }
  return issues;
}

const SEVERITY_RANK: Record<RetentionSeverity, number> = { high: 0, medium: 1 };

/** Issues in script order, high first within a beat, at most one per beat and kind. */
export function finalizeIssues(local: LocalIssue[], suggestions: Map<number, string>, beats: Array<{ index: number; text: string }>, max = 20): RetentionIssue[] {
  const seen = new Set<string>();
  const out: RetentionIssue[] = [];
  for (const i of [...local].sort((a, b) => a.beat_index - b.beat_index || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])) {
    const beat = beats.find((b) => b.index === i.beat_index);
    const key = `${i.beat_index}|${i.kind}`;
    if (!beat || seen.has(key)) continue;
    seen.add(key);
    const suggestion = suggestions.get(i.beat_index)?.trim();
    out.push({
      ...i,
      id: `ret-${i.beat_index}-${i.kind}`,
      checked_text: beat.text,
      ...(suggestion && suggestion !== beat.text.trim() ? { suggested_text: suggestion } : {}),
    });
  }
  // Keep the worst problems when there are many
  return out
    .map((x, order) => ({ x, order }))
    .sort((a, b) => SEVERITY_RANK[a.x.severity] - SEVERITY_RANK[b.x.severity] || a.order - b.order)
    .slice(0, max)
    .sort((a, b) => a.order - b.order)
    .map(({ x }) => x);
}

/** An estimate out of 100: the beats' average interest, less a little for each problem. */
export function retentionScore(marks: BeatMarks[], issues: Array<{ severity: RetentionSeverity }>): number {
  if (!marks.length) return 0;
  const avg = marks.reduce((s, m) => s + m.interest, 0) / marks.length;
  const base = ((avg - 1) / 4) * 100;
  const penalty = issues.reduce((s, i) => s + (i.severity === 'high' ? 6 : 2), 0);
  return Math.max(0, Math.min(100, Math.round(base - penalty)));
}

/** Open issues: not dismissed and still about the beat's current text. */
export function openRetentionIssues(report: RetentionReport | null | undefined, beats: Array<{ index: number; text: string }>): RetentionIssue[] {
  if (!report) return [];
  const text = new Map(beats.map((b) => [b.index, b.text]));
  return report.issues.filter((i) => !i.dismissed && text.get(i.beat_index) === i.checked_text);
}
