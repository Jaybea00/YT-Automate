import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { levelAudioInPlace, needsLevelling } from '../../src/pipeline/assembly/level-audio.ts';
import { measureLoudness, TARGET_LUFS } from '../../src/pipeline/assembly/master.ts';

const execFileAsync = promisify(execFile);

/** A small video with a steady tone at the given volume (dB below full scale). */
async function toneVideo(dir: string, name: string, volumeDb: number): Promise<string> {
  const file = path.join(dir, name);
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=gray:s=160x284:r=30:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-af', `volume=${volumeDb}dB`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ]);
  return file;
}

describe('Levelling a Short’s sound', () => {
  it('levels files that are too quiet, too loud or peak too hot, and leaves the rest', () => {
    assert.equal(needsLevelling({ input_i: '-24.6', input_tp: '-8' }), true, 'quiet');
    assert.equal(needsLevelling({ input_i: '-9', input_tp: '-0.5' }), true, 'loud');
    assert.equal(needsLevelling({ input_i: '-14.4', input_tp: '-2' }), false, 'already there');
    assert.equal(needsLevelling({ input_i: '-14', input_tp: '0.4' }), true, 'peaks too hot');
    assert.equal(needsLevelling({ input_i: '-70', input_tp: '-60' }), false, 'silence is left alone');
    assert.equal(needsLevelling({ input_i: '-inf', input_tp: '-inf' }), false, 'no sound at all');
  });

  it('brings a quiet video to the feed’s loudness without touching the picture', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'level-'));
    try {
      const file = await toneVideo(dir, 'quiet.mp4', -32);
      const before = Number.parseFloat((await measureLoudness(file)).input_i);
      const probe = async () => (await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames', '-of', 'csv=p=0', file])).stdout.trim();
      const pictureBefore = await probe();

      const result = await levelAudioInPlace(file);
      assert.equal(result.changed, true);
      assert.ok(Math.abs((result.beforeLufs ?? 0) - before) < 0.1);
      const after = Number.parseFloat((await measureLoudness(file)).input_i);
      assert.ok(Math.abs(after - TARGET_LUFS) <= 1, `levelled to ${after} LUFS`);
      assert.equal(await probe(), pictureBefore, 'same picture');

      // A second pass finds nothing to do
      assert.equal((await levelAudioInPlace(file)).changed, false);
      assert.deepEqual((await fs.readdir(dir)).sort(), ['quiet.mp4'], 'no temporary files left behind');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the file as it was when it can’t be read', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'level-'));
    try {
      const file = path.join(dir, 'broken.mp4');
      await fs.writeFile(file, 'not a video');
      const result = await levelAudioInPlace(file);
      assert.deepEqual(result, { beforeLufs: null, changed: false });
      assert.equal(await fs.readFile(file, 'utf-8'), 'not a video');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
