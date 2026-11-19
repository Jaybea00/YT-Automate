import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  beatTimeline,
  finalizeIssues,
  measuredIssues,
  openRetentionIssues,
  paceLimits,
  retentionScore,
  type BeatMarks,
  type OpenLoop,
  type PromiseCheck,
  type RetentionReport,
} from '../../src/lib/script/retention-types.ts';
import { buildRetentionPrompt, normalizeLoops, normalizeMarks } from '../../src/lib/script/retention.ts';
import type { ScriptBeat } from '../../src/lib/script/generate-script.ts';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const beat = (index: number, text = words(23)): ScriptBeat => ({ index, text, visual_type: 'stock', visual_query: 'x', duration_estimate_seconds: 10 });
const mark = (beat_index: number, over: Partial<BeatMarks> = {}): BeatMarks => ({
  beat_index,
  interest: 4,
  new_info: true,
  stakes: true,
  pattern_break: false,
  section_start: null,
  rehook: true,
  ...over,
});
/** n beats, each 10.5s (23 words at 2.3 words/s, plus the 0.5s pause). */
const setup = (n: number) => {
  const beats = Array.from({ length: n }, (_, i) => beat(i));
  return { beats, ...beatTimeline(beats) };
};
const paid: PromiseCheck = { promise: 'why it crashed', status: 'paid', paid_at: null, note: '' };
const kinds = (issues: Array<{ kind: string; beat_index: number }>) => issues.map((i) => `${i.kind}@${i.beat_index}`);

describe('timeline', () => {
  it('times each beat from its words plus a short pause', () => {
    const { starts, totalSeconds } = setup(3);
    assert.deepEqual(starts, [0, 10.5, 21]);
    assert.equal(totalSeconds, 31.5);
  });

  it('expects faster changes in a Short than in a long video', () => {
    assert.deepEqual(paceLimits(60), { breakEvery: 15, loopGap: 20 });
    assert.deepEqual(paceLimits(600), { breakEvery: 60, loopGap: 90 });
  });
});

describe('measured problems', () => {
  it('flags a weak hook, or an opening with no question', () => {
    const { starts, totalSeconds } = setup(4);
    const loops: OpenLoop[] = [{ question: 'why?', opened_at: 0, closed_at: 3 }];
    assert.deepEqual(kinds(measuredIssues({ starts, totalSeconds, marks: [mark(0, { interest: 3 }), mark(1), mark(2), mark(3)], loops, promise: paid })).filter((k) => k.startsWith('slow')), ['slow_start@0']);
    assert.deepEqual(kinds(measuredIssues({ starts, totalSeconds, marks: [0, 1, 2, 3].map((i) => mark(i)), loops, promise: paid })).filter((k) => k.startsWith('slow')), []);
    assert.deepEqual(kinds(measuredIssues({ starts, totalSeconds, marks: [0, 1, 2, 3].map((i) => mark(i)), loops: [], promise: paid })).filter((k) => k.startsWith('slow')), ['slow_start@0']);
  });

  it('reports a run of dead beats once, as serious', () => {
    const { starts, totalSeconds } = setup(6);
    const dead = { interest: 2, new_info: false, stakes: false };
    const marks = [mark(0), mark(1), mark(2, dead), mark(3, dead), mark(4), mark(5, dead)];
    const issues = measuredIssues({ starts, totalSeconds, marks, loops: [{ question: 'q', opened_at: 0, closed_at: 5 }], promise: paid }).filter((i) => i.kind === 'dead_beat');
    assert.deepEqual(issues.map((i) => [i.beat_index, i.severity]), [[2, 'high'], [5, 'medium']]);
    assert.match(issues[0].problem, /^2 beats in a row/);
  });

  it('flags sections that start without a re-hook', () => {
    const { starts, totalSeconds } = setup(4);
    const marks = [mark(0), mark(1), mark(2, { section_start: 'The crash', rehook: false, pattern_break: true }), mark(3)];
    const issues = measuredIssues({ starts, totalSeconds, marks, loops: [{ question: 'q', opened_at: 0, closed_at: 3 }], promise: paid });
    assert.ok(kinds(issues).includes('missing_rehook@2'));
  });

  it('flags long stretches without a change of pace', () => {
    // 12 beats x 10.5s: at 60s+ since the start with no break
    const { starts, totalSeconds } = setup(14);
    const marks = starts.map((_, i) => mark(i));
    const issues = measuredIssues({ starts, totalSeconds, marks, loops: [{ question: 'q', opened_at: 0, closed_at: 13 }], promise: paid });
    assert.deepEqual(kinds(issues).filter((k) => k.startsWith('no_pattern')), ['no_pattern_break@6', 'no_pattern_break@12']);
  });

  it('flags a long stretch with no open question', () => {
    const { starts, totalSeconds } = setup(20); // 210s
    const marks = starts.map((_, i) => mark(i, { pattern_break: true }));
    // A question open from 0 to beat 2, then nothing until the end
    const issues = measuredIssues({ starts, totalSeconds, marks, loops: [{ question: 'q', opened_at: 0, closed_at: 2 }], promise: paid });
    assert.deepEqual(kinds(issues).filter((k) => k.startsWith('no_open')), ['no_open_loop@2']);
  });

  it('checks the title\'s promise: unpaid, partly paid, or paid too early', () => {
    const { starts, totalSeconds } = setup(20);
    const marks = starts.map((_, i) => mark(i, { pattern_break: true }));
    const loops: OpenLoop[] = [{ question: 'q', opened_at: 0, closed_at: null }];
    const run = (promise: PromiseCheck) => measuredIssues({ starts, totalSeconds, marks, loops, promise }).filter((i) => i.kind === 'promise_unpaid' || i.kind === 'early_payoff');
    assert.deepEqual(run({ ...paid, status: 'unpaid' }).map((i) => [i.kind, i.beat_index, i.severity]), [['promise_unpaid', 19, 'high']]);
    assert.deepEqual(run({ ...paid, status: 'partial' }).map((i) => i.severity), ['medium']);
    assert.deepEqual(run({ ...paid, paid_at: 2 }).map((i) => [i.kind, i.beat_index]), [['early_payoff', 2]]);
    assert.deepEqual(run({ ...paid, paid_at: 18 }), []);
  });
});

describe('the report', () => {
  const beats = [beat(0, 'Hook text'), beat(1, 'Dull text'), beat(2, 'Fine text')];

  it('attaches the model\'s rewrite and drops duplicates', () => {
    const issues = finalizeIssues(
      [
        { beat_index: 1, kind: 'dead_beat', severity: 'medium', problem: 'p', fix_instruction: 'f' },
        { beat_index: 1, kind: 'dead_beat', severity: 'high', problem: 'p2', fix_instruction: 'f' },
        { beat_index: 0, kind: 'slow_start', severity: 'high', problem: 'p', fix_instruction: 'f' },
      ],
      new Map([[1, 'Sharper text'], [0, 'Hook text']]),
      beats,
    );
    assert.deepEqual(issues.map((i) => [i.id, i.severity, i.suggested_text]), [['ret-0-slow_start', 'high', undefined], ['ret-1-dead_beat', 'high', 'Sharper text']]);
    assert.equal(issues[1].checked_text, 'Dull text');
  });

  it('keeps the worst problems when there are too many, in script order', () => {
    const local = Array.from({ length: 5 }, (_, i) => ({ beat_index: i % 3, kind: (['dead_beat', 'no_pattern_break', 'missing_rehook', 'no_open_loop', 'slow_start'] as const)[i], severity: (i === 4 ? 'high' : 'medium') as 'high' | 'medium', problem: 'p', fix_instruction: 'f' }));
    const issues = finalizeIssues(local, new Map(), beats, 2);
    assert.equal(issues.length, 2);
    assert.ok(issues.some((i) => i.severity === 'high'));
  });

  it('scores from interest, less a little for each problem', () => {
    assert.equal(retentionScore([mark(0, { interest: 5 }), mark(1, { interest: 5 })], []), 100);
    assert.equal(retentionScore([mark(0, { interest: 3 })], [{ severity: 'high' }, { severity: 'medium' }]), 42);
    assert.equal(retentionScore([], []), 0);
  });

  it('hides dismissed issues and ones about text that has since changed', () => {
    const report = { issues: finalizeIssues([{ beat_index: 1, kind: 'dead_beat', severity: 'medium', problem: 'p', fix_instruction: 'f' }, { beat_index: 2, kind: 'no_pattern_break', severity: 'medium', problem: 'p', fix_instruction: 'f' }], new Map(), beats) } as RetentionReport;
    report.issues[1].dismissed = true;
    assert.equal(openRetentionIssues(report, beats).length, 1);
    assert.equal(openRetentionIssues(report, [beats[0], { ...beats[1], text: 'Edited' }, beats[2]]).length, 0);
  });
});

describe('model output', () => {
  const beats = [beat(0), beat(1), beat(2)];

  it('fills marks for skipped beats and clamps interest', () => {
    const marks = normalizeMarks([{ index: 1, interest: 9, new_info: false, stakes: false, pattern_break: true, section_start: ' Act two ', rehook: false }], beats);
    assert.equal(marks.length, 3);
    assert.deepEqual(marks[1], { beat_index: 1, interest: 5, new_info: false, stakes: false, pattern_break: true, section_start: 'Act two', rehook: false });
    assert.equal(marks[0].interest, 3);
  });

  it('drops questions that point at beats that don\'t exist', () => {
    const loops = normalizeLoops([{ question: 'ok', opened_at: 0, closed_at: 2 }, { question: 'bad', opened_at: 7, closed_at: null }, { question: 'backwards', opened_at: 2, closed_at: 1 }, { question: ' ', opened_at: 0, closed_at: 1 }], 3);
    assert.deepEqual(loops, [{ question: 'ok', opened_at: 0, closed_at: 2 }, { question: 'backwards', opened_at: 2, closed_at: null }]);
  });

  it('gives the model the timings, the title and the planned promise', () => {
    const { starts, totalSeconds } = beatTimeline(beats);
    const prompt = buildRetentionPrompt({ beats, starts, totalSeconds, title: 'Why the Concorde died', promise: 'why it was retired', styleLabel: 'Story / History' });
    assert.match(prompt, /TITLE: Why the Concorde died/);
    assert.match(prompt, /PROMISE THE VIDEO WAS PLANNED TO DELIVER: why it was retired/);
    assert.match(prompt, /\[1\] 0:10 word0/);
    assert.match(prompt, /every 15s/);
  });
});
