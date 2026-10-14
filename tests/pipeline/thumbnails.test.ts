import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { candidateMoments, fallbackPlans, normalizePlans, renderThumbnails, thumbnailLines, THUMB_HEIGHT, THUMB_WIDTH } from '../../src/pipeline/publish/thumbnails.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import type { VideoTimeline } from '../../src/pipeline/utils/timeline.ts';

const execFileAsync = promisify(execFile);

describe('Thumbnails', () => {
  it('sets short lines so the text can be huge', () => {
    assert.deepEqual(thumbnailLines('PANIC AT THE BANK'.split(' ')).map((l) => l.join(' ')), ['PANIC AT', 'THE BANK']);
    assert.deepEqual(thumbnailLines('THIRTY BILLION LOST'.split(' ')).map((l) => l.join(' ')), ['THIRTY', 'BILLION', 'LOST']);
    assert.ok(thumbnailLines('A B C D E F G H I J K L M N O P Q R S T U V'.split(' ')).length <= 3);
  });

  it('keeps picks usable: distinct frames, a few words, stated numbers, text opposite the subject', () => {
    const plans = normalizePlans(
      [
        { frame: 2, text: 'panic at the bank', highlight: 'panic', subject_side: 'left' },
        { frame: 2, text: 'duplicate frame', highlight: 'x', subject_side: 'center' },
        { frame: 4, text: '50 BILLION GONE', highlight: '50 BILLION', subject_side: 'right' },
        { frame: 5, text: '30 BILLION GONE', highlight: 'NOT IN TEXT', subject_side: 'center' },
        { frame: 99, text: 'OUT OF RANGE', highlight: 'x', subject_side: 'left' },
      ],
      6,
      'About thirty billion dollars vanished.',
    );
    assert.deepEqual(plans, [
      { frame: 2, text: 'PANIC AT THE BANK', highlight: 'PANIC', side: 'right' },
      { frame: 5, text: '30 BILLION GONE', highlight: 'GONE', side: 'left' },
    ]);
    assert.equal(fallbackPlans(10, 'The Day Wall Street Broke').length, 3);
  });

  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbs-'));
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('takes candidates from clean footage shots, skipping ones with name captions', async () => {
    const track = path.join(dir, 'visuals_beat_0.mp4');
    await fs.writeFile(
      `${track}.shots.json`,
      JSON.stringify({ beatIndex: 0, shots: [
        { renderedType: 'title', startSec: 0, durationSec: 2 },
        { renderedType: 'archive', startSec: 2, durationSec: 4 },
        { renderedType: 'stock', startSec: 6, durationSec: 2, note: 'caption: Hoover' },
        { renderedType: 'stock', startSec: 8, durationSec: 2 },
        { renderedType: 'archive', startSec: 10, durationSec: 2 },
      ] }),
    );
    const timeline: VideoTimeline = { version: 1, renderedAt: '', totalMs: 20_000, beats: [{ index: 0, sceneStartMs: 5000, sceneMs: 12_000, voiceStartMs: 5200, voiceMs: 11_000, audioPath: null, trackPath: track }] };
    const moments = await candidateMoments(timeline, 'final.mp4');
    assert.deepEqual(moments.map((m) => [m.source === track, m.sourceSec, m.atSec]), [[true, 4, 9], [true, 9, 14], [true, 11, 16]]);

    const noTracks = await candidateMoments({ ...timeline, beats: [{ ...timeline.beats[0], trackPath: null }] }, 'final.mp4');
    assert.equal(noTracks.length, 12, 'evenly spread frames of the finished video');
    assert.ok(noTracks.every((m) => m.source === 'final.mp4'));
  });

  it('renders 1280x720 JPEGs under the 2 MB limit', async () => {
    const frame = path.join(dir, 'frame.jpg');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080', '-frames:v', '1', frame]);
    const thumbs = await renderThumbnails({
      plans: [{ frame: 0, text: 'PANIC AT THE BANK', highlight: 'PANIC', side: 'left' }, { frame: 0, text: 'THIRTY BILLION LOST', highlight: 'LOST', side: 'right' }],
      frames: [{ full: frame, atSec: 3 }],
      theme: themeForStyle('story_driven'),
      outDir: dir,
    });
    assert.equal(thumbs.length, 2);
    for (const t of thumbs) {
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', t.path]);
      assert.equal(stdout.trim().replace(/,$/, ''), `${THUMB_WIDTH},${THUMB_HEIGHT}`);
      assert.ok((await fs.stat(t.path)).size < 2 * 1024 * 1024);
    }
  });
});
