import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sharpenSmallPhoto } from '../../src/pipeline/visuals/upscale.ts';

const execFileAsync = promisify(execFile);
const photo = (file: string, w: number) => execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${w}x${Math.round(w * 0.6)}`, '-frames:v', '1', file]);

describe('Sharpening small photos', () => {
  it('upscales only small photos, once, and keeps the original if anything fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upscale-'));
    try {
      const small = path.join(dir, 'small.jpg');
      const big = path.join(dir, 'big.jpg');
      await photo(small, 400);
      await photo(big, 1600);
      let runs = 0;
      const fake = async (image: string) => {
        runs++;
        assert.equal(image, small);
        return { save: async (p: string) => fs.copyFile(small, p) };
      };

      assert.equal(await sharpenSmallPhoto(big, fake), big, 'a large photo is used as it is');
      assert.equal(runs, 0);
      const sharp = await sharpenSmallPhoto(small, fake);
      assert.equal(sharp, `${small}.x2.png`);
      assert.ok((await fs.stat(sharp)).size > 0);
      assert.equal(await sharpenSmallPhoto(small, fake), sharp);
      assert.equal(runs, 1, 'made once, then kept');

      const other = path.join(dir, 'other.jpg');
      await photo(other, 300);
      const broken = async () => {
        throw new Error('model unavailable');
      };
      assert.equal(await sharpenSmallPhoto(other, broken), other, 'falls back to the original');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
