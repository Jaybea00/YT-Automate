import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeVoicePacing, videoPacing } from '../../src/lib/script/voice-pacing.ts';
import { AssemblyProgressTracker, estimateSecondsLeft, followFfmpegProgress, overallFraction } from '../../src/pipeline/runner/assembly-progress.ts';
import { clearJoinCheckpoint, joinFingerprint, readJoinCheckpoint, writeJoinCheckpoint } from '../../src/pipeline/assembly/join-checkpoint.ts';
import { joinSceneClips, joinStepCount } from '../../src/pipeline/assembly/assemble-beat.ts';
import { masterFinalVideo } from '../../src/pipeline/assembly/master.ts';

const execFileAsync = promisify(execFile);

async function clip(file: string, seconds: number, colour: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:r=30:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-shortest', file,
  ]);
}

describe('Voice pace per video', () => {
  it('keeps a sensible pace, and falls back to the style\'s when the video has none', () => {
    assert.deepEqual(normalizeVoicePacing({ speed: 0.88, sentencePauseSec: 0.25 }), { speed: 0.88, sentencePauseSec: 0.25 });
    assert.equal(normalizeVoicePacing({ speed: 0.3 }), null, 'too slow');
    assert.equal(normalizeVoicePacing({ speed: 1, sentencePauseSec: 5 }), null, 'too long a breath');
    assert.equal(normalizeVoicePacing('fast'), null);
    assert.deepEqual(videoPacing({ speed: 0.88, sentencePauseSec: 0.25 }, 'stickman_pov'), { speed: 0.88, sentencePauseSec: 0.25 });
    assert.equal(videoPacing(undefined, 'stickman_pov'), undefined, 'POV has no pacing of its own');
    assert.deepEqual(videoPacing(undefined, 'history'), { speed: 0.9, sentencePauseSec: 0.35, beatPauseSec: 1 }, 'documentary styles are slower');
    assert.equal(videoPacing({ speed: 1, sentencePauseSec: 0 }, 'history'), undefined, 'Normal chosen on purpose means the voice as it is');
  });
});

describe('Assembly progress', () => {
  it('weights each step by its share of the time and estimates the time left from this run\'s speed', () => {
    assert.equal(overallFraction('scenes', 0), 0);
    assert.equal(overallFraction('scenes', 1), overallFraction('join', 0));
    assert.ok(Math.abs(overallFraction('master', 0.5) - 0.78) < 0.001, 'half way through mastering is about 78%');
    assert.equal(overallFraction('check', 1), 1);
    assert.equal(estimateSecondsLeft(0.02, 0, 600), undefined, 'too early to judge');
    assert.equal(estimateSecondsLeft(0.5, 0, 1800), 1800, 'half done in 30 min: 30 min left');
    assert.equal(estimateSecondsLeft(0.6, 0.2, 1200), 1200, 'a resumed run judges by its own progress');
  });

  it('writes the step, percentage and time to the job folder, and follows ffmpeg\'s progress reports', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-'));
    try {
      const file = path.join(dir, 'progress.json');
      const tracker = new AssemblyProgressTracker(file);
      await tracker.set('join', 0.5, 'step 6 of 12', true);
      const written = JSON.parse(await fs.readFile(file, 'utf-8'));
      assert.equal(written.label, 'Joining scenes');
      assert.equal(written.detail, 'step 6 of 12');
      assert.equal(written.percent, 33.5);
      await tracker.clear();
      await assert.rejects(fs.stat(file));

      const report = path.join(dir, 'ff.txt');
      await fs.writeFile(report, 'frame=10\nout_time_us=2000000\nprogress=continue\nframe=20\nout_time_us=5000000\nprogress=continue\n');
      const seen: number[] = [];
      const stop = followFfmpegProgress(report, 10, (f) => seen.push(f), 20);
      await new Promise((r) => setTimeout(r, 90));
      stop();
      assert.ok(seen.length > 0 && seen.every((f) => f === 0.5), 'the latest position: 5 s of 10');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('counts the join\'s steps and reports each one', async () => {
    assert.equal(joinStepCount(4), 1);
    assert.equal(joinStepCount(8), 3, 'two groups of six, then the groups');
    assert.equal(joinStepCount(60), 13, 'ten groups, two of those, then the final');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'joinprog-'));
    try {
      const clips = Array.from({ length: 8 }, (_, i) => path.join(dir, `c${i}.mp4`));
      await Promise.all(clips.map((c, i) => clip(c, 1, ['red', 'green', 'blue', 'white'][i % 4])));
      const reports: string[] = [];
      await joinSceneClips(clips, path.join(dir, 'out.mp4'), dir, { transition: 'crossfade', onProgress: (d, t) => reports.push(`${d}/${t}`) });
      assert.deepEqual(reports, ['1/3', '2/3', '3/3']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Resuming after a shutdown', () => {
  it('reuses the joined scenes only while the scenes and transitions are unchanged, and never a cut-off file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'joinckpt-'));
    try {
      const scenes = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];
      await clip(scenes[0], 1, 'red');
      await clip(scenes[1], 1, 'blue');
      const key = await joinFingerprint(scenes, { transition: 'style' });
      assert.notEqual(await joinFingerprint(scenes, { transition: 'cut' }), key, 'other transitions, other join');
      const joined = path.join(dir, 'joined.mp4');
      await clip(joined, 2, 'green');
      const checkpoint = path.join(dir, 'program_joined.mp4');
      await writeJoinCheckpoint(joined, checkpoint, key, { overlapSec: 0.4, overlapsSec: [0.4] });
      assert.deepEqual(await readJoinCheckpoint(checkpoint, key), { overlapSec: 0.4, overlapsSec: [0.4] });
      assert.equal(await readJoinCheckpoint(checkpoint, 'another-key'), null);
      // A scene rendered again changes the fingerprint
      await new Promise((r) => setTimeout(r, 20));
      await clip(scenes[1], 1, 'white');
      assert.notEqual(await joinFingerprint(scenes, { transition: 'style' }), key);
      // A file cut off mid-write (no index) is never reused
      const bytes = await fs.readFile(checkpoint);
      await fs.writeFile(checkpoint, bytes.subarray(0, Math.floor(bytes.length / 3)));
      assert.equal(await readJoinCheckpoint(checkpoint, key), null);
      await clearJoinCheckpoint(checkpoint);
      assert.equal((await fs.readdir(dir)).filter((f) => f.startsWith('program_joined')).length, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports mastering progress through ffmpeg', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'masterprog-'));
    try {
      const input = path.join(dir, 'in.mp4');
      await clip(input, 2, 'red');
      const report = path.join(dir, 'p.txt');
      await masterFinalVideo({ inputPath: input, outputPath: path.join(dir, 'out.mp4'), progressFile: report });
      assert.match(await fs.readFile(report, 'utf-8'), /out_time_us=\d+[\s\S]*progress=end/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
