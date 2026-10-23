import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MIN_MOVE_SEC, planTransitions, startsFromOverlaps, vocabularyFor, type Boundary } from '../../src/pipeline/assembly/transitions.ts';
import { joinSceneClips, probeClipDurationSec } from '../../src/pipeline/assembly/assemble-beat.ts';
import { STYLE_PACKS } from '../../src/lib/styles/packs.ts';
import { CUSTOM_TRANSITIONS, CUSTOM_TRANSITION_NAMES, isCustomTransition, xfadeTransitionOption } from '../../src/pipeline/assembly/custom-transitions.ts';

const execFileAsync = promisify(execFile);
const plain = (n: number, silenceSec = 1): Boundary[] => Array.from({ length: n }, () => ({ chapter: false, reveal: false, silenceSec }));

async function xfadeNames(): Promise<Set<string>> {
  const { stdout, stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-h', 'filter=xfade']);
  const text = stdout + stderr;
  return new Set([...text.matchAll(/^\s{5,}([a-z]+)\s/gm)].map((m) => m[1]));
}

describe('Style-matched transitions', () => {
  it('uses only transitions this ffmpeg has, for every style', async () => {
    const names = await xfadeNames();
    for (const style of Object.keys(STYLE_PACKS)) {
      const v = vocabularyFor(style);
      for (const t of [...v.light, ...v.chapter, ...v.reveal]) assert.ok(names.has(t), `${style}: ${t}`);
    }
  });

  it('gives each style its own language', () => {
    assert.ok(vocabularyFor('sport').light.includes('smoothleft'));
    assert.ok(vocabularyFor('tech').chapter.includes('pixelize'));
    assert.ok(vocabularyFor('history').chapter.includes('fadeblack'));
    assert.deepEqual(vocabularyFor('unknown'), vocabularyFor('cinematic'));
  });

  it('cuts mostly inside chapters, moves bigger at chapters and into reveals, never repeating', () => {
    const b = plain(12);
    b[5] = { chapter: true, reveal: false, silenceSec: 2 };
    b[9] = { chapter: false, reveal: true, silenceSec: 1 };
    const plan = planTransitions(b, 'sport', 'balanced');
    assert.equal(plan[5].sec, 0.8, 'chapter change');
    assert.ok(vocabularyFor('sport').chapter.includes(plan[5].type));
    assert.ok(vocabularyFor('sport').reveal.includes(plan[9].type));
    const light = plan.filter((p, i) => i !== 5 && i !== 9 && p.type !== 'cut');
    assert.ok(light.length >= 2 && light.length <= 4, `balanced: about every third join (${light.length})`);
    const moves = plan.filter((p) => p.type !== 'cut').map((p) => p.type);
    moves.slice(1).forEach((t, i) => assert.notEqual(t, moves[i], 'no back-to-back repeats'));
  });

  it('scales with intensity', () => {
    const count = (level: 'subtle' | 'balanced' | 'bold') => planTransitions(plain(24), 'tech', level).filter((p) => p.type !== 'cut').length;
    assert.ok(count('subtle') < count('balanced') && count('balanced') < count('bold'));
  });

  it('never fades a spoken word: moves fit in the silence or become cuts', () => {
    const plan = planTransitions(
      [
        { chapter: true, reveal: false, silenceSec: 0.5 },
        { chapter: true, reveal: false, silenceSec: MIN_MOVE_SEC },
      ],
      'history',
    );
    assert.equal(plan[0].sec, 0.45);
    assert.deepEqual(plan[1], { type: 'cut', sec: 0 });
  });

  it('times each clip from the overlaps at its joins', () => {
    assert.deepEqual(startsFromOverlaps([5, 4, 6, 3], [0.5, 0, 0.8]), [0, 4.5, 8.5, 13.7]);
  });

  it('joins a long run with mixed transitions and cuts, across groups, at the expected length', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'style-join-'));
    try {
      const clips: string[] = [];
      for (let i = 0; i < 9; i++) {
        const clip = path.join(dir, `c${i}.mp4`);
        await execFileAsync('ffmpeg', [
          '-y', '-v', 'error',
          '-f', 'lavfi', '-i', `color=c=0x${(i * 25 + 30).toString(16).padStart(2, '0')}4060:s=640x360:r=30`,
          '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
          '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip,
        ]);
        clips.push(clip);
      }
      const joins = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? { type: i === 6 ? 'pixelize' : 'slideleft', sec: 0.4 } : { type: 'cut', sec: 0 }));
      const out = path.join(dir, 'out.mp4');
      const joined = await joinSceneClips(clips, out, dir, { transition: 'style', joins });
      assert.deepEqual(joined.overlapsSec, [0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0]);
      const durations = await Promise.all(clips.map((c) => probeClipDurationSec(c)));
      const expected = durations.reduce((a, b) => a + b, 0) - 1.6;
      const actual = await probeClipDurationSec(out);
      assert.ok(Math.abs(actual - expected) < 0.15, `length ${actual} vs ${expected}`);

      const allCuts = await joinSceneClips(clips.slice(0, 3), path.join(dir, 'cuts.mp4'), dir, { transition: 'style', joins: [{ type: 'cut', sec: 0 }, { type: 'cut', sec: 0 }] });
      assert.deepEqual(allCuts.overlapsSec, [0, 0], 'all cuts use the lossless join');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Rendered transitions', () => {
  it('lead chapter changes and reveals when switched on, and never appear inside chapters', () => {
    const b = plain(10);
    b[4] = { chapter: true, reveal: false, silenceSec: 2 };
    b[7] = { chapter: false, reveal: true, silenceSec: 2 };
    const plan = planTransitions(b, 'history', 'bold', { rendered: true });
    assert.equal(plan[4].type, 'filmburn');
    assert.equal(plan[7].type, 'lightleak');
    plan.forEach((p, i) => {
      if (i !== 4 && i !== 7) assert.ok(!isCustomTransition(p.type), `join ${i} is ${p.type}`);
    });
    assert.ok(!planTransitions(b, 'history', 'bold').some((p) => isCustomTransition(p.type)), 'off: built-in only');
    for (const style of Object.keys(STYLE_PACKS)) {
      const v = vocabularyFor(style, true);
      assert.ok(v.chapter.some(isCustomTransition), `${style} has a rendered chapter transition`);
    }
  });

  it('never keep values in shared registers (xfade runs them on several threads)', () => {
    for (const [name, expr] of Object.entries(CUSTOM_TRANSITIONS)) assert.doesNotMatch(expr, /\b(st|ld)\(/, name);
  });

  it('render every effect, the same on many threads as on one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rendered-'));
    try {
      const a = path.join(dir, 'a.mp4');
      const b = path.join(dir, 'b.mp4');
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=192x108:r=30', '-t', '1', '-pix_fmt', 'yuv420p', a]);
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=192x108:r=30', '-t', '1', '-pix_fmt', 'yuv420p', b]);
      for (const name of CUSTOM_TRANSITION_NAMES) {
        const outs: string[] = [];
        for (const threads of [[], ['-filter_complex_threads', '1']]) {
          const out = path.join(dir, `${name}_${threads.length}.png`);
          await execFileAsync('ffmpeg', [
            '-y', '-v', 'error', ...threads, '-i', a, '-i', b,
            '-filter_complex', `[0:v][1:v]xfade=${xfadeTransitionOption(name)}:duration=0.4:offset=0.3,trim=start=0.45:end=0.5,setpts=PTS-STARTPTS[v]`,
            '-map', '[v]', '-frames:v', '1', out,
          ]);
          outs.push(out);
        }
        const { stderr } = await execFileAsync('ffmpeg', ['-i', outs[0], '-i', outs[1], '-lavfi', 'psnr', '-f', 'null', '-']);
        const psnr = stderr.match(/average:(inf|[\d.]+)/)?.[1];
        assert.ok(psnr === 'inf' || Number(psnr) > 45, `${name}: threaded render matches (${psnr} dB)`);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
