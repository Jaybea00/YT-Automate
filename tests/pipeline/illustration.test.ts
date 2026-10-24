import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { capIllustrations, finalizeBeatShots, verifyShot, MAX_ILLUSTRATIONS } from '../../src/lib/script/shot-planner.ts';
import { illustrationPrompt, tagAsIllustration, tagImageAsIllustration } from '../../src/pipeline/visuals/illustration.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { stylePack } from '../../src/lib/styles/packs.ts';
import type { ScriptBeat, ShotPlan } from '../../src/lib/script/generate-script.ts';

const execFileAsync = promisify(execFile);
const beat = (index: number, shots: ShotPlan[]): ScriptBeat => ({ index, text: 'Deep in space a black hole waits.', visual_type: 'stock', visual_query: 'space', duration_estimate_seconds: 5, shots });
const ill = (prompt = 'a black hole with a glowing disk in deep space'): ShotPlan => ({ visual_type: 'illustration', visual_query: 'black hole', covers: '', word_start: 0, word_count: 3, illustration: { prompt } });
const stock = (): ShotPlan => ({ visual_type: 'stock', visual_query: 'stars', covers: '', word_start: 0, word_count: 3 });

describe('AI illustrations (free, labelled)', () => {
  it('are on by default only for the styles where nothing was filmed', () => {
    assert.equal(stylePack('space_science')?.illustrations, true);
    assert.equal(stylePack('history')?.illustrations, true);
    assert.ok(!stylePack('sport')?.illustrations);
    assert.ok(!stylePack('finance')?.illustrations);
    assert.ok(!stylePack('true_crime_pov')?.illustrations);
  });

  it('stay rare: one in eight shots at most, and a ceiling per video', () => {
    // Two illustrations three shots apart: the second becomes footage of the same subject
    const capped = capIllustrations([beat(0, [ill(), stock(), stock(), ill('a roman legion marching at dawn under red banners')])]);
    assert.deepEqual(capped[0].shots!.map((s) => s.visual_type), ['illustration', 'stock', 'stock', 'stock']);
    assert.match(capped[0].shots![3].visual_query, /roman legion/);
    assert.equal(capped[0].shots![3].illustration, undefined);

    const many = capIllustrations(Array.from({ length: 12 }, (_, i) => beat(i, [ill(), ...Array.from({ length: 8 }, stock)])));
    assert.equal(many.flatMap((b) => b.shots!).filter((s) => s.visual_type === 'illustration').length, MAX_ILLUSTRATIONS);
  });

  it('need a real description, and only where the video allows them', () => {
    const b = beat(0, []);
    assert.equal(verifyShot({ visual_type: 'illustration', covers: '', visual_query: 'x', illustration: { prompt: 'space' } }, b, []).visual_type, 'stock', 'too vague');
    assert.equal(verifyShot({ visual_type: 'illustration', covers: '', visual_query: 'x', illustration: { prompt: 'a black hole bending the light of distant stars' } }, b, []).visual_type, 'illustration');
    const director = [{ visual_type: 'illustration' as const, covers: 'Deep in space a black hole waits.', visual_query: 'black hole', illustration: { prompt: 'a black hole bending the light of distant stars' } }];
    assert.equal(finalizeBeatShots(b, director, [], { illustrations: true })[0].visual_type, 'illustration');
    assert.equal(finalizeBeatShots(b, director, [], { illustrations: false })[0].visual_type, 'stock', 'off for this video: footage instead');
  });

  it('asks for the shot prompt, else its subject, else its narration', () => {
    assert.equal(illustrationPrompt({ illustration: { prompt: 'a nebula' }, visual_query: 'q', covers: 'c' }), 'a nebula');
    assert.equal(illustrationPrompt({ visual_query: 'a comet', covers: 'c' }), 'a comet');
  });

  it('carries the "Illustration" tag on clips and pictures, without changing their length or size', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ill-'));
    try {
      const clip = path.join(dir, 'c.mp4');
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x103060:s=1920x1080:r=30', '-frames:v', '45', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]);
      await tagAsIllustration(clip, themeForStyle('space_science'));
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', clip]);
      assert.equal(Number(stdout.trim()), 45);
      const corner = async (file: string, x: number, y: number) =>
        Array.from((await execFileAsync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-'], { encoding: 'buffer' })).stdout as Buffer);
      const tag = await corner(clip, 70, 72);
      const plain = await corner(clip, 1500, 900);
      assert.notDeepEqual(tag, plain, 'the tag sits in the top-left corner');

      const image = path.join(dir, 'i.jpg');
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x103060:s=1280x720', '-frames:v', '1', image]);
      await tagImageAsIllustration(image, themeForStyle('space_science'));
      const { stdout: dims } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', image]);
      assert.equal(dims.trim(), '1280,720');
      assert.notDeepEqual(await corner(image, 47, 48), await corner(image, 1000, 600), 'scaled tag on the picture');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
