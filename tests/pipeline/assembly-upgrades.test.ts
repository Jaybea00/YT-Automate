import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeArgs, hardwareAllowed } from '../../src/pipeline/utils/video-encoder.ts';
import { coverGraph, describeFixes, hasFixes, holdFrameAt, planFixes } from '../../src/pipeline/assembly/final-fix.ts';
import type { QualityReport } from '../../src/pipeline/assembly/final-check.ts';
import { endScreenGraph, endScreenMusicLift, endScreenSettings } from '../../src/pipeline/assembly/end-screen.ts';
import { planPacing, tightenFromRetention, videoPacing } from '../../src/pipeline/assembly/pacing.ts';
import { phaseTimings } from '../../src/pipeline/runner/assembly-progress.ts';
import { buildRenderReport, formatDuration } from '../../src/pipeline/runner/render-report.ts';

describe('encoder choice', () => {
  it('uses the graphics chip for joins only, unless told otherwise', () => {
    assert.equal(hardwareAllowed('join', {}), true);
    assert.equal(hardwareAllowed('scene', {}), false);
    assert.equal(hardwareAllowed('draft', {}), false);
    assert.equal(hardwareAllowed('master', {}), false);
    assert.equal(hardwareAllowed('master', { VIDEO_ENCODER_MASTER: 'hardware' }), true);
    assert.equal(hardwareAllowed('join', { VIDEO_ENCODER: 'software' }), false);
  });

  it('gives each encoder its own arguments, as fresh copies', () => {
    assert.ok(encodeArgs('join', 'hardware').includes('h264_qsv'));
    assert.ok(encodeArgs('join', 'software').includes('libx264'));
    const a = encodeArgs('master', 'software');
    a.push('x');
    assert.ok(!encodeArgs('master', 'software').includes('x'));
  });
});

describe('final check fixes', () => {
  const report = (statuses: Record<string, 'pass' | 'warn' | 'fail'>, black = [{ start: 8, end: 8.6 }]): QualityReport => ({
    checkedAt: '',
    passed: false,
    checks: Object.entries(statuses).map(([id, status]) => ({ id, label: id, status, detail: `${id} detail` })),
    found: { black, silence: [], videoSec: 24, audioSec: 22.5 },
  });

  it('plans only fixes that keep the length, and only for failing checks', () => {
    const f = planFixes(report({ loudness: 'fail', peaks: 'pass', sync: 'fail', black: 'warn', silence: 'fail', freeze: 'warn', format: 'pass' }));
    assert.deepEqual(f, { loudness: true, sync: true, black: [{ start: 8, end: 8.6 }], format: false });
    assert.equal(hasFixes(planFixes(report({ loudness: 'pass', silence: 'fail', freeze: 'warn' }))), false);
  });

  it('leaves a long black stretch alone (a missing shot, not a flash)', () => {
    assert.deepEqual(planFixes(report({ black: 'fail' }, [{ start: 3, end: 7 }])).black, []);
  });

  it('says what it fixed', () => {
    const r = report({ loudness: 'fail', peaks: 'warn', black: 'warn' });
    const d = describeFixes(planFixes(r), r);
    assert.deepEqual(d.map((x) => x.id), ['loudness', 'black']);
    assert.match(d[1].detail, /1 black flash covered .*0:08\.0/);
  });

  it('holds the frame before a flash, or after one that opens the video', () => {
    assert.equal(holdFrameAt({ start: 8, end: 8.6 }), 7.9);
    assert.equal(holdFrameAt({ start: 0, end: 0.5 }), 0.6);
    assert.equal(coverGraph([], 1, false), '[0:v]format=yuv420p[vout]');
    const g = coverGraph([{ start: 1, end: 2 }, { start: 5, end: 5.5 }], 1, true);
    assert.match(g, /\[1:v\].*\[0:v\]\[h0\]overlay.*between\(t,1\.000,2\.000\).*\[2:v\].*\[c0\]\[h1\]overlay/);
    assert.match(g, /\[c1\]scale=1920:1080.*fps=30,format=yuv420p\[vout\]$/);
  });
});

describe('end screen', () => {
  it('defaults to on, 12 seconds, "Watch next", kept within YouTube\'s 5-20 s', () => {
    assert.deepEqual(endScreenSettings(undefined), { enabled: true, seconds: 12, text: 'Watch next' });
    assert.deepEqual(endScreenSettings({ enabled: false, seconds: 40, text: '  ' }), { enabled: false, seconds: 20, text: '' });
    assert.equal(endScreenSettings({ seconds: 1 }).seconds, 5);
  });

  it('lifts the music once the voice stops', () => {
    assert.equal(endScreenMusicLift(60), 'if(lt(t,60.000),1,1+0.8*min(1,(t-60.000)/1.5))');
  });

  it('draws the heading only when there is one', () => {
    assert.match(endScreenGraph(12, true), /\[bg\]\[hd\]overlay/);
    assert.doesNotMatch(endScreenGraph(12, false), /overlay/);
  });
});

describe('pacing from the retention check', () => {
  const beats = ['One long flowing line that keeps going on and on and on.', 'Another long flowing line that keeps going on and on here.', 'A third long flowing line that keeps going on and on and on.', 'The fourth and final line that ends the video for good now.'].map(
    (text, index) => ({ index, text }),
  );
  const sections = [{ start_beat: 0, title: 'A' }, { start_beat: 3, title: 'B' }];

  it('shortens pauses after dull beats, adds a little after gripping ones, keeps chapter changes', () => {
    const base = planPacing(beats, sections, 0.5);
    const marks = [
      { beat_index: 0, interest: 2 },
      { beat_index: 1, interest: 5 },
      { beat_index: 2, interest: 1 }, // the next beat opens a section: kept
    ];
    const { plan, tightened, loosened } = tightenFromRetention(base, { marks });
    assert.deepEqual(tightened, [0]);
    assert.deepEqual(loosened, [1]);
    assert.equal(plan.get(0)!.tailSec, Math.max(0.08, base.get(0)!.tailSec * 0.5));
    assert.ok(plan.get(1)!.tailSec > base.get(1)!.tailSec);
    assert.deepEqual(plan.get(2), base.get(2));
    assert.equal(plan.get(0)!.leadInSec, base.get(0)!.leadInSec);
  });

  it('treats a flagged dead beat as dull, unless dismissed', () => {
    const base = planPacing(beats, sections, 0.5);
    const marks = [{ beat_index: 1, interest: 3 }];
    assert.deepEqual(tightenFromRetention(base, { marks, issues: [{ beat_index: 1, kind: 'dead_beat' }] }).tightened, [1]);
    assert.deepEqual(tightenFromRetention(base, { marks, issues: [{ beat_index: 1, kind: 'dead_beat', dismissed: true }] }).tightened, []);
  });

  it('ignores a check made for different beats, and can be turned off', () => {
    const retention = { beatsChecked: 4, marks: [{ beat_index: 0, interest: 1 }] };
    const base = planPacing(beats, sections, 0.5);
    assert.notDeepEqual(videoPacing(beats, sections, { retention }).get(0), base.get(0));
    assert.deepEqual(videoPacing(beats, sections, { retention: { ...retention, beatsChecked: 3 } }).get(0), base.get(0));
    assert.deepEqual(videoPacing(beats, sections, { retention, pacing_from_retention: false }).get(0), base.get(0));
  });
});

describe('render report', () => {
  it('times each step from when it began to when the next began', () => {
    const t = phaseTimings(0, [{ phase: 'scenes', at: 1000 }, { phase: 'join', at: 5000 }, { phase: 'master', at: 9000 }], 10000);
    assert.deepEqual(t.map((p) => [p.phase, p.sec]), [['scenes', 5], ['join', 4], ['master', 1]]);
  });

  it('names the slowest step and what was reused', () => {
    const r = buildRenderReport({
      phases: [{ phase: 'scenes', label: 'Rendering scenes', sec: 60 }, { phase: 'join', label: 'Joining scenes', sec: 300 }, { phase: 'master', label: 'Mastering', sec: 240 }],
      totalBeats: 10,
      rebuiltBeats: [2, 5],
      joinReused: false,
      encodes: { hardware: 3, software: 2, fellBack: 0 },
      endScreenSec: 12,
      fixed: 0,
      hardwareAvailable: true,
    });
    assert.equal(r.totalSec, 600);
    assert.deepEqual(r.beats, { total: 10, rebuilt: 2, reused: 8 });
    assert.match(r.notes[0], /Joining scenes took the longest: 5m 00s of 10m 00s \(50%\)/);
    assert.match(r.notes.join(' '), /2 of 10 beats were rebuilt/);
    assert.match(r.notes.join(' '), /graphics chip/);
    assert.equal(formatDuration(3725), '1h 02m');
  });
});
