import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cropPositions, reframeSegments, smoothPath, subjectCentre } from '../../src/pipeline/publish/reframe.ts';
import { renderShort } from '../../src/pipeline/publish/shorts.ts';
import type { VideoTimeline } from '../../src/pipeline/utils/timeline.ts';

const execFileAsync = promisify(execFile);

const beat = (index: number, startMs: number, ms: number, trackPath: string | null) => ({
  index, sceneStartMs: startMs, sceneMs: ms, voiceStartMs: startMs + 200, voiceMs: ms - 400, audioPath: null, trackPath,
});

describe('Shorts smart reframing', () => {
  it('crops footage shots and keeps graphics, short crops and unknown beats whole', async () => {
    const timeline: VideoTimeline = {
      version: 1,
      renderedAt: '',
      totalMs: 20_000,
      beats: [beat(0, 0, 10_000, 'track0.mp4'), beat(1, 10_000, 10_000, null)],
    };
    const shots = {
      'track0.mp4': [
        { renderedType: 'stock', startSec: 0, durationSec: 3 },
        { renderedType: 'archive', startSec: 3, durationSec: 2 },
        { renderedType: 'chart', startSec: 5, durationSec: 2 },
        { renderedType: 'stock', startSec: 7, durationSec: 0.8 },
        { renderedType: 'kinetic_text', startSec: 7.8, durationSec: 2.2 },
      ],
    } as Record<string, Array<{ renderedType: string; startSec: number; durationSec: number }>>;
    const segments = await reframeSegments(timeline, { startSec: 1, endSec: 20 }, async (p) => ({ shots: shots[p] ?? [] }));
    assert.deepEqual(
      segments.map((s) => [s.mode, +s.startSec.toFixed(2), +s.endSec.toFixed(2)]),
      [
        ['crop', 0, 4],
        ['fit', 4, 19],
      ],
      'stock and archive join up; the 0.8 s stock shot stays whole; a beat without a shot record stays whole',
    );
  });

  it('finds the nearest subject in a depth map, and nothing in a flat one', () => {
    const w = 64;
    const h = 36;
    const map = new Uint8Array(w * h).fill(30);
    for (let y = 10; y < 30; y++) for (let x = 44; x < 56; x++) map[y * w + x] = 220;
    const x = subjectCentre(map, w, h);
    assert.ok(x !== null && Math.abs(x - 50 / 64) < 0.05, `subject on the right (${x})`);
    assert.equal(subjectCentre(new Uint8Array(w * h).fill(128), w, h), null);
  });

  it('pans smoothly: small moves ignored, big ones limited in speed, gaps held', () => {
    const path1 = smoothPath([
      { t: 0, x: 0.5 },
      { t: 1, x: 0.52 },
      { t: 2, x: null },
      { t: 3, x: 0.9 },
      { t: 4, x: 0.9 },
    ]);
    assert.equal(path1[1].x, 0.5, 'a 2% move is ignored');
    assert.equal(path1[2].x, 0.5, 'a frame with no subject holds');
    assert.ok(path1[3].x - path1[2].x <= 0.18 + 1e-9, 'no faster than the pan limit');
    assert.ok(path1[4].x > path1[3].x, 'keeps heading to the subject');

    const px = cropPositions([{ t: 0, x: 0.99 }], { startSec: 0, endSec: 0.1, mode: 'crop' }, 1920, 608);
    assert.equal(px[0].px, 1920 - 608, 'the crop never leaves the picture');
  });

  it('renders footage full-frame on the subject and graphics whole', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reframe-'));
    try {
      // 3 s of "footage": black with a red subject on the right; then 3 s of a green "chart"
      const source = path.join(dir, 'final.mp4');
      await execFileAsync('ffmpeg', [
        '-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=30:d=3,drawbox=x=1500:y=300:w=200:h=500:color=red:t=fill',
        '-f', 'lavfi', '-i', 'color=c=green:s=1920x1080:r=30:d=3',
        '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=6',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source,
      ]);
      const track = path.join(dir, 'track.mp4');
      await fs.writeFile(
        `${track}.shots.json`,
        JSON.stringify({ beatIndex: 0, shots: [{ renderedType: 'stock', startSec: 0, durationSec: 3 }, { renderedType: 'chart', startSec: 3, durationSec: 3 }] }),
      );
      const clip = await renderShort({
        videoPath: source,
        plan: { startBeat: 0, endBeat: 0, title: 'T', hook: 'HOOK' },
        timeline: { version: 1, renderedAt: '', totalMs: 6000, beats: [beat(0, 0, 6000, track)] },
        beats: [{ index: 0, text: 'Words' }],
        words: {},
        highlightHex: '#e3b04b',
        outPath: path.join(dir, 'short_1.mp4'),
        reframe: true,
        findSubject: async () => 1600 / 1920,
      });
      const pixel = async (t: number, x: number, y: number) => {
        const { stdout } = await execFileAsync(
          'ffmpeg',
          ['-v', 'error', '-ss', String(t), '-i', clip.path, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
          { encoding: 'buffer' },
        );
        return Array.from(stdout as Buffer);
      };
      const [r, g, b] = await pixel(1, 540, 960);
      assert.ok(r > 150 && g < 80 && b < 80, `the subject fills the middle of the frame (${r},${g},${b})`);
      const [r2, g2] = await pixel(4.3, 540, 820);
      assert.ok(g2 > 90 && r2 < 80, `the chart is shown (${r2},${g2})`);
      const [, gBelow] = await pixel(4.3, 540, 1500);
      assert.ok(gBelow < g2 - 20, 'below the whole chart is the darker blurred fill, not the chart');
      assert.deepEqual(await fs.readdir(dir).then((f) => f.filter((n) => /crop\.txt$|_reframe$/.test(n))), [], 'working files are cleaned up');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
