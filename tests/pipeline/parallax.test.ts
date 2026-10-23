import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { depthMap, parallaxClip, parallaxFilter, suitsParallax } from '../../src/pipeline/visuals/parallax.ts';
import { renderCandidateShot } from '../../src/pipeline/visuals/shot-renderers.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import type { ShotPlan } from '../../src/lib/script/generate-script.ts';

const execFileAsync = promisify(execFile);

async function frameCount(file: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
  return Number(stdout.trim().replace(/,$/, ''));
}

/** A photo and a hand-made depth map (a bright "near" block on a dark "far" field), so no model download is needed. */
async function scene(dir: string, size = '1280x720') {
  const photo = path.join(dir, 'photo.jpg');
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${size}`, '-frames:v', '1', photo]);
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x202020:s=${size}`, '-vf', 'drawbox=x=iw/3:y=ih/3:w=iw/3:h=ih/2:color=white:t=fill,format=gray', '-frames:v', '1', `${photo}.depth.png`]);
  return photo;
}

describe('2.5D parallax', () => {
  it('moves near things sideways and pushes in, holding one decoded frame', () => {
    const f = parallaxFilter(120, 1);
    assert.match(f, /loop=loop=119:size=1/);
    assert.match(f, /geq=lum='clip\(128\+36\*/);
    assert.match(f, /displace=edge=smear,crop=1920:1080/);
    assert.match(f, /format=gbrp/, 'displaced in RGB so colour never fringes');
    assert.match(parallaxFilter(120, -1), /\(-1\*\(2\*/, 'the glide can go either way');
  });

  it('only takes landscape photos that fill the frame', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parallax-fit-'));
    try {
      const wide = await scene(dir);
      assert.equal(await suitsParallax(wide), true);
      const tall = path.join(dir, 'tall.jpg');
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280', '-frames:v', '1', tall]);
      assert.equal(await suitsParallax(tall), false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses a saved depth map instead of running the model again', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parallax-depth-'));
    try {
      const photo = await scene(dir);
      assert.equal(await depthMap(photo), `${photo}.depth.png`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('renders exactly the shot length and cleans up after itself', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parallax-clip-'));
    try {
      const photo = await scene(dir);
      const out = path.join(dir, 'clip.mp4');
      await parallaxClip({ imagePath: photo, depthPath: `${photo}.depth.png`, frames: 45, outputPath: out, n: 0 });
      assert.equal(await frameCount(out), 45);
      const leftover = (await fs.readdir(dir)).filter((f) => f.startsWith('clip.mp4.'));
      assert.deepEqual(leftover, [], 'the scaled intermediates are cleaned up');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('is used for plain photos when switched on, and credited as the same photo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parallax-shot-'));
    try {
      const photo = await scene(dir);
      const shot = { visual_type: 'stock', visual_query: 'x', covers: 'x', word_start: 0, word_count: 5 } as ShotPlan;
      const out = path.join(dir, 'shot.mp4');
      // The download step copies the photo; give the copy the same depth map
      const ctx = { beatIndex: 0, downloadDir: dir, theme: themeForStyle('cinematic'), usedSources: new Set(), motionCounter: { next: 0 }, parallax: { count: { next: 0 } } };
      const candidate = { id: 'u1', provider: 'uploaded' as const, mediaType: 'image' as const, title: 'p', thumbnailUrl: '', downloadUrl: photo, license: 'own_work' };
      const crypto = await import('node:crypto');
      const copy = path.join(dir, `uploaded_${crypto.createHash('sha1').update(photo).digest('hex').slice(0, 16)}.jpg`);
      await fs.copyFile(`${photo}.depth.png`, `${copy}.depth.png`);
      const rendered = await renderCandidateShot(shot, { shot, startSec: 0, frames: 30 }, out, ctx as never, candidate);
      assert.match(rendered.note ?? '', /parallax/);
      assert.equal(rendered.license, 'own_work');
      assert.equal(await frameCount(out), 30);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
