import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bestMusicOffset, cutsOnBeat, detectBeatGrid, programCuts } from '../../src/pipeline/assembly/music-beats.ts';
import { applyBackgroundMusic } from '../../src/pipeline/assembly/bgm.ts';
import { buildMusicBed } from '../../src/pipeline/assembly/music-bed.ts';

const execFileAsync = promisify(execFile);
const meanDb = async (file: string, from: number, to: number) => {
  const { stderr } = await execFileAsync('ffmpeg', ['-v', 'info', '-ss', String(from), '-t', String(to - from), '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  return Number.parseFloat(/mean_volume: (-?[\d.]+) dB/.exec(stderr)![1]);
};

describe('Cuts on the beat', () => {
  let dir: string;
  let click: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beats-'));
    // 120 BPM clicks, the first at 0.2 s
    click = path.join(dir, 'click.wav');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*880*t)*exp(-40*mod(t-0.2+10,0.5))*gt(t,0.2)':s=44100:d=30", click]);
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('finds the tempo and the first beat, and caches them', async () => {
    const grid = (await detectBeatGrid(click))!;
    assert.ok(Math.abs(grid.periodSec - 0.5) < 0.02, `120 BPM (${grid.periodSec})`);
    assert.ok(Math.abs(grid.phaseSec - 0.2) < 0.04, `first beat at 0.2 s (${grid.phaseSec})`);
    assert.ok(grid.confidence > 0.6);
    assert.ok(await fs.stat(`${click}.beats.json`));
  });

  it('starts the music where its beats meet the most cuts', () => {
    const grid = { periodSec: 0.5, phaseSec: 0.2, confidence: 0.9 };
    const cuts = [1.0, 2.0, 3.5, 4.12];
    const offset = bestMusicOffset(cuts, grid);
    assert.ok(Math.abs(offset - 0.2) < 0.015, `offset ${offset}`);
    assert.equal(cutsOnBeat(cuts, grid, offset), 3, 'three of four cuts on a beat');
    assert.equal(cutsOnBeat(cuts, grid, 0), 0, 'none without the offset');
    assert.equal(bestMusicOffset([], grid), 0);
  });

  it('collects every cut: beat starts and the shots inside composed beats', async () => {
    const cuts = await programCuts(
      [
        { sceneStartMs: 0, trackPath: 'a' },
        { sceneStartMs: 4000, trackPath: null },
        { sceneStartMs: 7000, trackPath: 'c' },
      ],
      async (t) => (t === 'a' ? { shots: [{ startSec: 0 }, { startSec: 1.5 }, { startSec: 2.8 }] } : { shots: [{ startSec: 0 }, { startSec: 2 }] }),
    );
    assert.deepEqual(cuts, [1.5, 2.8, 4, 7, 9]);
  });

  it('really starts the music later in the track, in both the bed and single-track music', async () => {
    // Silent for 1.5 s, then a tone: an offset of 1.5 s starts on the tone
    const music = path.join(dir, 'late.wav');
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=1.5', '-f', 'lavfi', '-i', 'sine=f=330:r=48000:d=6',
      '-filter_complex', '[0][1]concat=n=2:v=0:a=1', music,
    ]);
    const bed = path.join(dir, 'bed.m4a');
    await buildMusicBed([{ startMs: 0, endMs: 4000, mood: 'calm', track: { path: music, title: 't' } } as never], bed, [1.5]);
    assert.ok((await meanDb(bed, 0.1, 1.2)) > -40, 'the bed starts on the tone');

    const video = path.join(dir, 'v.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
    ]);
    const plain = path.join(dir, 'plain.mp4');
    const shifted = path.join(dir, 'shifted.mp4');
    await applyBackgroundMusic({ videoPath: video, bgmPath: music, outputPath: plain, volume: 0.5 });
    await applyBackgroundMusic({ videoPath: video, bgmPath: music, outputPath: shifted, volume: 0.5, startOffsetSec: 1.5 });
    assert.ok((await meanDb(plain, 0.1, 1.2)) < -60, 'without an offset the start is silent');
    assert.ok((await meanDb(shifted, 0.1, 1.2)) > -40, 'with it the tone plays from the start');
  });
});
