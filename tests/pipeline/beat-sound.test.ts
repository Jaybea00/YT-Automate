import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beatMusicExpression, normalizeBeatSound, readBeatSounds, withPauses, withoutMutedSfx } from '../../src/pipeline/assembly/beat-sound.ts';
import { applyBackgroundMusic } from '../../src/pipeline/assembly/bgm.ts';

const execFileAsync = promisify(execFile);

/** Mean volume (dB) of a stretch of a file's audio. */
async function meanDb(file: string, fromSec: number, toSec: number): Promise<number> {
  const { stderr } = await execFileAsync('ffmpeg', ['-v', 'info', '-ss', String(fromSec), '-t', String(toSec - fromSec), '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  return Number.parseFloat(/mean_volume: (-?[\d.]+) dB/.exec(stderr)![1]);
}

describe('Per-beat sound controls', () => {
  it('cleans controls and drops ones that change nothing', () => {
    assert.deepEqual(normalizeBeatSound({ music: 3, muteSfx: true, pauseAfterSec: 9 }), { music: 2, muteSfx: true, pauseAfterSec: 4 });
    assert.equal(normalizeBeatSound({ music: 1, muteSfx: false, pauseAfterSec: 0 }), null);
    assert.deepEqual(normalizeBeatSound({ music: 0 }), { music: 0 });
    assert.deepEqual(readBeatSounds({ 2: { pauseAfterSec: 1.25 }, x: { music: 0 }, 3: {} }), { 2: { pauseAfterSec: 1.3 } });
  });

  it('adds dramatic pauses to the beat tails, mutes effects in muted beats', () => {
    const pacing = new Map([
      [0, { leadInSec: 0.2, tailSec: 0.5, dipIn: false, dipOut: false }],
      [1, { leadInSec: 0.2, tailSec: 0.5, dipIn: false, dipOut: false }],
    ]);
    const paced = withPauses(pacing, { 1: { pauseAfterSec: 2 } });
    assert.equal(paced.get(0)!.tailSec, 0.5);
    assert.equal(paced.get(1)!.tailSec, 2.5);
    assert.equal(pacing.get(1)!.tailSec, 0.5, 'the plan passed in is left alone');

    const cues = [{ atMs: 500 }, { atMs: 4500 }, { atMs: 9000 }];
    const scenes = [
      { index: 0, startMs: 0, endMs: 4000 },
      { index: 1, startMs: 4000, endMs: 8000 },
      { index: 2, startMs: 8000, endMs: 10000 },
    ];
    assert.deepEqual(withoutMutedSfx(cues, { 1: { muteSfx: true } }, scenes), [{ atMs: 500 }, { atMs: 9000 }]);
    assert.equal(withoutMutedSfx(cues, {}, scenes), cues);
  });

  it('builds a music level curve that ffmpeg plays: a silenced beat really goes quiet', async () => {
    assert.equal(beatMusicExpression({}, [{ index: 0, startSec: 0, endSec: 3 }]), '');
    const expr = beatMusicExpression({ 1: { music: 0 }, 2: { pauseAfterSec: 1 } }, [
      { index: 0, startSec: 0, endSec: 3 },
      { index: 1, startSec: 3, endSec: 6 },
      { index: 2, startSec: 6, endSec: 9 },
    ]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beatsound-'));
    try {
      const video = path.join(dir, 'program.mp4');
      const music = path.join(dir, 'music.wav');
      await execFileAsync('ffmpeg', [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=9', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-t', '9', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
      ]);
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=9', music]);
      const out = path.join(dir, 'out.mp4');
      await applyBackgroundMusic({ videoPath: video, bgmPath: music, outputPath: out, volume: 0.5, accentExpression: expr });
      const normal = await meanDb(out, 1, 2.5);
      const silenced = await meanDb(out, 3.8, 5.2);
      const pause = await meanDb(out, 8.3, 8.9);
      assert.ok(silenced < normal - 30, `beat 2's music is silenced (${normal} dB vs ${silenced} dB)`);
      assert.ok(pause < normal - 10 && pause > silenced, `the pause dips the music without silencing it (${pause} dB)`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
