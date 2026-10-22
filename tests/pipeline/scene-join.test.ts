import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { XFADE_GROUP_SIZE, computeSceneStartOffsetsSec, joinSceneClips, probeClipDurationSec } from '../../src/pipeline/assembly/assemble-beat.ts';

const execFileAsync = promisify(execFile);

/** A short 1080p30 clip with stereo sound, like an assembled scene. */
async function scene(file: string, seconds: number, colour: string, withAudio = true): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=1920x1080:r=30:d=${seconds}`,
    ...(withAudio ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    ...(withAudio ? ['-c:a', 'aac', '-ac', '2', '-ar', '48000', '-shortest'] : []),
    file,
  ]);
}

describe('Joining scenes with crossfades', () => {
  it('crossfades many scenes in groups, exactly as long as one pass would be', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'join-'));
    try {
      const colours = ['red', 'green', 'blue', 'yellow', 'white', 'gray', 'purple', 'orange'];
      assert.ok(colours.length > XFADE_GROUP_SIZE, 'the test needs more than one group');
      const clips = colours.map((c) => path.join(dir, `${c}.mp4`));
      await Promise.all(clips.map((p, i) => scene(p, 1.5, colours[i])));

      const out = path.join(dir, 'joined.mp4');
      const joined = await joinSceneClips(clips, out, dir, { transition: 'crossfade' });
      assert.ok(joined.overlapSec > 0, 'the crossfades were applied');

      const durations = await Promise.all(clips.map((p) => probeClipDurationSec(p)));
      const expected = durations.reduce((a, b) => a + b, 0) - (clips.length - 1) * joined.overlapSec;
      const actual = await probeClipDurationSec(out);
      assert.ok(Math.abs(actual - expected) < 0.1, `joined ${actual.toFixed(2)} s, expected ${expected.toFixed(2)} s`);

      // The captions' beat starts agree with the video: the last scene starts where the offsets say
      const starts = computeSceneStartOffsetsSec(durations, 'crossfade');
      assert.ok(Math.abs(starts.at(-1)! + durations.at(-1)! - actual) < 0.1);
      assert.deepEqual((await fs.readdir(dir)).filter((f) => f.startsWith('xfade_')), [], 'group files are cleaned up');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to cuts, and says so, when a crossfade cannot be made', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'join-'));
    try {
      const clips = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];
      await scene(clips[0], 1.5, 'red');
      await scene(clips[1], 1.5, 'blue', false); // no sound: the audio crossfade fails
      const out = path.join(dir, 'joined.mp4');
      const joined = await joinSceneClips(clips, out, dir, { transition: 'crossfade' });
      assert.equal(joined.overlapSec, 0, 'reported as cuts, so captions are timed for cuts');
      const sum = (await probeClipDurationSec(clips[0])) + (await probeClipDurationSec(clips[1]));
      assert.ok(Math.abs((await probeClipDurationSec(out)) - sum) < 0.15);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports no overlap for cuts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'join-'));
    try {
      const clips = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];
      await Promise.all(clips.map((p) => scene(p, 1, 'red')));
      const joined = await joinSceneClips(clips, path.join(dir, 'joined.mp4'), dir, { transition: 'cut' });
      assert.equal(joined.overlapSec, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
