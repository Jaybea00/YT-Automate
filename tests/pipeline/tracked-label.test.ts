import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { labelMovingSubject, smoothTrack, trackTarget, trackedLabelDocument } from '../../src/pipeline/visuals/tracked-label.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';

const execFileAsync = promisify(execFile);
const W = 320;
const H = 180;

/** Grey frames with a textured square moving right by `speed` pixels a frame. */
function movingSquare(n: number, speed: number, vanishAt = Infinity): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => {
    const f = new Uint8Array(W * H).fill(60);
    if (i >= vanishAt) return f;
    const x0 = 40 + i * speed;
    for (let y = 70; y < 100; y++) for (let x = x0; x < x0 + 30 && x < W; x++) f[y * W + x] = ((x - x0) * 7 + y * 13) % 200 + 40;
    return f;
  });
}

describe('Labels that follow moving footage', () => {
  it('follows a moving subject frame by frame', () => {
    const track = trackTarget(movingSquare(40, 3), { x: 40, y: 70, w: 30, h: 30 });
    assert.equal(track.length, 40);
    assert.ok(track.every(Boolean), 'never lost');
    assert.ok(Math.abs(track[39]!.x - (40 + 39 * 3 + 15)) <= 2, `ends over the square (${track[39]!.x})`);
    assert.ok(Math.abs(track[39]!.y - 85) <= 2);
  });

  it('lets go when the subject disappears', () => {
    const track = trackTarget(movingSquare(40, 2, 20), { x: 40, y: 70, w: 30, h: 30 });
    assert.ok(track[18], 'followed while visible');
    assert.equal(track[30], null, 'lost once it is gone');
    const smooth = smoothTrack([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, null]);
    assert.equal(smooth[1]!.x, 10);
    assert.equal(smooth[3], null);
  });

  it('puts the label on the side with room, the ring at its anchor', () => {
    const art = trackedLabelDocument(themeForStyle('vox_explainer'), { target: 'the cyclist', label: 'Tadej Pogačar', detail: 'leader' }, 140, true);
    assert.equal(art.anchor.x, 90, 'ring on the left, label to its right');
    assert.match(art.html, /Tadej Pogačar/);
    const left = trackedLabelDocument(themeForStyle('vox_explainer'), { target: 'x', label: 'Y' }, 140, false);
    assert.equal(left.anchor.x, left.width - 90);
  });

  it('labels a real clip: the ring rides with the subject', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'track-'));
    try {
      // A red square crossing a grey frame for 2 seconds
      const clip = path.join(dir, 'clip.mp4');
      await execFileAsync('ffmpeg', [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=1920x1080:r=30:d=2', '-f', 'lavfi', '-i', 'testsrc2=s=200x200:r=30:d=2',
        '-filter_complex', '[0:v][1:v]overlay=x=300+t*400:y=440[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip,
      ]);
      const vision: LLMProvider = {
        kind: 'llm',
        id: 'fake-vision',
        supportsVision: true,
        generateText: async () => ({ text: '', usage: {} }),
        // The square starts at x 300-500, y 440-640 of 1920x1080
        generateJson: async () => ({ data: { found: true, label_fits: true, box: [407, 156, 593, 260] }, usage: {} }) as never,
      };
      const before = (await fs.stat(clip)).size;
      const ok = await labelMovingSubject({ clipPath: clip, annotation: { target: 'the square', label: 'The square' }, theme: themeForStyle('history'), llm: vision, llmCtx: {} as never });
      assert.equal(ok, true);
      assert.notEqual((await fs.stat(clip)).size, before, 'the clip now carries the label');
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', clip]);
      assert.equal(Number(stdout.trim()), 60, 'same length');
      // At 1.5 s the square has moved 600 px; the ring's accent should be near its new centre, not the old one
      const ringNear = async (t: number, x: number) => {
        const { stdout: px } = await execFileAsync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', clip, '-frames:v', '1', '-vf', `format=rgb24,crop=260:260:${x - 130}:410`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
        const b = px as Buffer;
        let colourful = 0;
        for (let i = 0; i < b.length; i += 3) if (Math.max(b[i], b[i + 1], b[i + 2]) - Math.min(b[i], b[i + 1], b[i + 2]) > 80) colourful++;
        return colourful;
      };
      assert.ok((await ringNear(1.5, 1000)) > 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
