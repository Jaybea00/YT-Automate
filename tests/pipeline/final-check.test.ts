import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookFilter, LOOK_THEMES } from '../../src/pipeline/assembly/look.ts';
import { masterFinalVideo, videoColorRange } from '../../src/pipeline/assembly/master.ts';
import { parseDetections, runFinalQualityCheck, unintendedBlack } from '../../src/pipeline/assembly/final-check.ts';

const execFileAsync = promisify(execFile);
const ff = (...args: string[]) => execFileAsync('ffmpeg', ['-y', '-v', 'error', ...args]);

describe('One look per style', () => {
  it('has a grade for every style theme, and can be switched off', () => {
    for (const t of ['documentary', 'vox', 'tech', 'business', 'warm', 'noir']) assert.ok(LOOK_THEMES.includes(t), t);
    assert.match(lookFilter('documentary')!, /^eq=/);
    assert.equal(lookFilter('documentary', 'off'), null);
    assert.equal(lookFilter('unknown-theme'), null);
    // Cheap YUV filters only: these multiplied mastering time on this class of machine
    for (const t of LOOK_THEMES) assert.doesNotMatch(lookFilter(t)!, /colorbalance|vignette|noise=/);
  });
});

describe('Final quality check', () => {
  it('reads black frames, freezes and silences from ffmpeg output', () => {
    const stderr = [
      '[blackdetect @ 0x1] black_start:4.5 black_end:4.9 black_duration:0.4',
      '[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 10',
      '[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 15',
      '[silencedetect @ 0x3] silence_start: 20.5',
      '[silencedetect @ 0x3] silence_end: 24 | silence_duration: 3.5',
    ].join('\n');
    assert.deepEqual(parseDetections(stderr), {
      black: [{ start: 4.5, end: 4.9 }],
      freeze: [{ start: 10, end: 15 }],
      silence: [{ start: 20.5, end: 24 }],
    });
  });

  it('ignores the dips at section changes and the closing fade', () => {
    const black = [{ start: 59.4, end: 60.4 }, { start: 30, end: 31.2 }, { start: 119, end: 120 }];
    assert.deepEqual(unintendedBlack(black, [60], 120), [{ start: 30, end: 31.2 }]);
  });

  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'final-check-'));
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('catches a black gap and dead air in a broken video, and passes a clean one', async () => {
    // 8 s: moving picture with a black second at 3 s, and a voice that goes silent from 4 s
    const broken = path.join(dir, 'broken.mp4');
    await ff(
      '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30,drawbox=c=black:t=fill:enable=between(t\\,3\\,4.2)',
      '-f', 'lavfi', '-i', "sine=f=300:r=48000,volume='if(lt(t,4),0.3,0)':eval=frame",
      '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', broken,
    );
    const bad = await runFinalQualityCheck(broken, { sectionChangesSec: [], expectedDurationSec: 8 });
    const status = Object.fromEntries(bad.checks.map((c) => [c.id, c.status]));
    assert.equal(status.black, 'fail', 'a 1.2 s black gap mid-video');
    assert.equal(status.silence, 'warn', 'about 3.5 s of dead air before the end');
    assert.equal(status.format, 'pass');
    assert.equal(bad.passed, false);

    const clean = path.join(dir, 'clean.mp4');
    await ff(
      '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30', '-f', 'lavfi', '-i', 'sine=f=300:r=48000,volume=0.3',
      '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', clean,
    );
    const good = await runFinalQualityCheck(clean, { expectedDurationSec: 6 });
    assert.deepEqual(good.checks.filter((c) => ['format', 'sync', 'length', 'black', 'freeze', 'silence'].includes(c.id)).map((c) => c.status), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  });

  it('converts a full-range source to TV range at mastering, with or without a look', async () => {
    const fullRange = path.join(dir, 'full.mp4');
    await ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=f=300:r=48000,volume=0.3', '-t', '2',
      '-vf', 'format=yuvj420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', fullRange);
    assert.equal(await videoColorRange(fullRange), 'pc');
    // Converted output is TV range: tagged "tv", or untagged, which players read as TV range
    const plain = path.join(dir, 'plain.mp4');
    await masterFinalVideo({ inputPath: fullRange, outputPath: plain });
    assert.notEqual(await videoColorRange(plain), 'pc', 'converted even with no look or captions');
    const graded = path.join(dir, 'graded.mp4');
    await masterFinalVideo({ inputPath: fullRange, outputPath: graded, lookFilter: lookFilter('noir') });
    assert.notEqual(await videoColorRange(graded), 'pc');
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', graded]);
    assert.equal(stdout.trim().replace(/,$/, ''), 'yuv420p');
  });
});
