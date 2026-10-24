import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { composeSplit, splitLayout, splitOverlayDocument } from '../../src/pipeline/visuals/split-shot.ts';
import { MOTION_RENDERERS } from '../../src/pipeline/visuals/motion-shots.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { verifyShot } from '../../src/lib/script/shot-planner.ts';
import { kindOf } from '../../src/lib/script/visual-rhythm.ts';
import type { ScriptBeat } from '../../src/lib/script/generate-script.ts';

const execFileAsync = promisify(execFile);
const pixel = async (file: string, x: number, y: number) => {
  const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-'], { encoding: 'buffer' });
  return Array.from(stdout as Buffer);
};

describe('Split-screen and photo grids', () => {
  it('lays out pairs, threes and grids edge to edge with gutters', () => {
    assert.deepEqual(splitLayout(2), [{ x: 0, y: 0, w: 956, h: 1080 }, { x: 964, y: 0, w: 956, h: 1080 }]);
    assert.equal(splitLayout(3).length, 3);
    assert.equal(splitLayout(3)[2].x + splitLayout(3)[2].w, 1920);
    const grid = splitLayout(4);
    assert.deepEqual(grid.map((r) => [r.x, r.y]), [[0, 0], [964, 0], [0, 544], [964, 544]]);
    assert.ok(grid.every((r) => r.w % 2 === 0 && r.h % 2 === 0));
    assert.equal(kindOf('split'), 'footage', 'counts as footage for the visual rhythm');
    assert.ok(MOTION_RENDERERS.split, 'registered');
  });

  it('crops each picture into its place and lays the labels on top', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'split-'));
    try {
      const clips = await Promise.all(
        ['red', 'blue'].map(async (c) => {
          const f = path.join(dir, `${c}.mp4`);
          await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=1920x1080:r=30`, '-frames:v', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
          return f;
        }),
      );
      const rects = splitLayout(2);
      const spec = { title: 'Then and now', panels: [{ query: 'a', label: '1929', archive: true }, { query: 'b', label: 'Today', archive: false }] };
      const html = splitOverlayDocument(themeForStyle('history'), spec, rects);
      assert.match(html, />VS</);
      const png = path.join(dir, 'overlay.png');
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.setContent(html);
        await page.screenshot({ path: png, omitBackground: true });
      } finally {
        await browser.close();
      }
      const out = path.join(dir, 'split.mp4');
      await composeSplit(clips, png, rects, 30, out);
      const [lr] = await pixel(out, 400, 300);
      const [, , rb] = await pixel(out, 1500, 300);
      assert.ok(lr > 180, 'left panel is the first picture');
      assert.ok(rb > 180, 'right panel is the second');
      const gutter = await pixel(out, 960, 300);
      assert.ok(gutter.every((v) => v < 40), 'a dark gutter between them');
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out]);
      assert.equal(Number(stdout.trim()), 30, 'exactly the shot length');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a split only with two or more distinct panels and short, grounded labels', () => {
    const beat: ScriptBeat = { index: 0, text: 'Milan in 1929 looked nothing like Milan today.', visual_type: 'archive', visual_query: 'Milan 1929', duration_estimate_seconds: 5 };
    const ok = verifyShot(
      { visual_type: 'split', covers: '', visual_query: 'Milan then and now', split: { title: 'Milan', panels: [{ query: 'Milan street 1929', label: '1929', archive: true }, { query: 'Milan street today', label: 'A label far too long to fit here', archive: false }] } },
      beat,
      [],
    );
    assert.equal(ok.visual_type, 'split');
    assert.deepEqual(ok.split?.panels.map((p) => p.label), ['1929', null], 'an over-long label is dropped, the panel kept');
    const lonely = verifyShot({ visual_type: 'split', covers: '', visual_query: 'Milan', split: { title: null, panels: [{ query: 'Milan street', label: null, archive: true }] } }, beat, []);
    assert.equal(lonely.visual_type, 'archive', 'one panel is just footage');
    const twins = verifyShot({ visual_type: 'split', covers: '', visual_query: 'Milan', split: { title: null, panels: [{ query: 'Milan street', archive: true }, { query: 'milan street', archive: true }] } }, beat, []);
    assert.equal(twins.visual_type, 'archive', 'two identical searches are not a comparison');
  });
});
