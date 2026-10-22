import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ensureArchiveTextures,
  printComposeFilter,
  textureOverlayFilter,
  treatmentFor,
} from '../../src/pipeline/visuals/archive-look.ts';
import { makeFootageClip } from '../../src/pipeline/visuals/clips.ts';

const execFileAsync = promisify(execFile);

async function probe(file: string): Promise<{ width: number; height: number; frames: number }> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', file]);
  const s = JSON.parse(stdout).streams[0];
  return { width: s.width, height: s.height, frames: Number(s.nb_read_frames) };
}

async function meanSaturation(file: string): Promise<number> {
  const { stderr } = await execFileAsync('ffmpeg', ['-v', 'info', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.SATAVG', '-f', 'null', '-']);
  const values = [...stderr.matchAll(/SATAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  return values.reduce((a, b) => a + b, 0) / values.length;
}

describe('Archive texture filters', () => {
  it('alternates print tilts and opens every third archive shot with a light leak', () => {
    const tex = { grain: 'g.mp4' };
    const looks = [0, 1, 2, 3, 4].map((n) => treatmentFor(n, tex));
    assert.ok(looks.every((l, i) => i === 0 || Math.sign(l.tilt) !== Math.sign(looks[i - 1].tilt)), 'tilts alternate sides');
    assert.deepEqual(looks.map((l) => l.leak), [false, true, false, false, true]);
  });

  it('builds a print with a shadow, and a second print beneath when given one', () => {
    const single = printComposeFilter(-1.8, false);
    assert.match(single, /rotate=a=-0\.0314/);
    assert.match(single, /\[shadow\]/);
    assert.doesNotMatch(single, /\[1:v\]/);
    assert.match(printComposeFilter(1.3, true), /\[1:v\]scale=.*\[ucard\]/);
  });

  it('adds grain to brightness only, keeping the footage colour', () => {
    const f = textureOverlayFilter('in', 'out', 1);
    assert.match(f, /c0_mode=overlay/);
    assert.match(f, /c1_mode=normal:c1_opacity=1:c2_mode=normal:c2_opacity=1/);
    assert.match(textureOverlayFilter('in', 'out', 1, true), /overlay=eof_action=pass/);
  });
});

describe('Archive texture rendering', () => {
  it('renders old film and old photos at exact length, without draining colour', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-look-'));
    try {
      const textures = await ensureArchiveTextures();
      // A vivid red test film and two test photos
      const film = path.join(dir, 'film.mp4');
      await execFileAsync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=3', '-vf', 'colorchannelmixer=rr=1:gg=0.2:bb=0.2', '-pix_fmt', 'yuv420p', film]);
      const photoA = path.join(dir, 'a.jpg');
      const photoB = path.join(dir, 'b.jpg');
      await execFileAsync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1600x1000', '-frames:v', '1', photoA]);
      await execFileAsync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'smptebars=s=900x1200', '-frames:v', '1', photoB]);

      const plain = path.join(dir, 'plain.mp4');
      const treated = path.join(dir, 'treated.mp4');
      await makeFootageClip({ inputPath: film, isVideo: true, frames: 45, outputPath: plain });
      await makeFootageClip({ inputPath: film, isVideo: true, frames: 45, outputPath: treated, archiveLook: treatmentFor(1, textures) });
      assert.deepEqual(await probe(treated), { width: 1920, height: 1080, frames: 45 });
      const [satPlain, satTreated] = [await meanSaturation(plain), await meanSaturation(treated)];
      assert.ok(satTreated > satPlain * 0.8, `colour kept: ${satTreated.toFixed(1)} vs ${satPlain.toFixed(1)}`);

      const print = path.join(dir, 'print.mp4');
      await makeFootageClip({ inputPath: photoB, isVideo: false, frames: 40, outputPath: print, motion: 'zoom_in', archiveLook: treatmentFor(2, textures, photoA) });
      assert.deepEqual(await probe(print), { width: 1920, height: 1080, frames: 40 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
