import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  extractCandidateNumber,
  extractBeatIndexFromFilename,
  autoMapFilesToBeats,
} from '../../src/lib/visuals/batch-mapper';
import { handleBatchVisualUpload } from '../../src/app/api/videos/[id]/visuals/batch/route';
import { createMockSupabase } from '../helpers/mock-supabase';

const execFileAsync = promisify(execFile);

describe('Batch Visuals Uploader & Auto-Mapper Tests', () => {
  let tempDir: string;
  let validMp4Buffer: Buffer;
  let validPngBuffer: Buffer;

  const testVideoId = '22222222-3333-4444-5555-666666666666';
  const fiveBeatsScript = {
    beats: [
      { text: 'Beat 0 intro hook', visual_type: 'stock', visual_query: 'nature forest' },
      { text: 'Beat 1 science problem', visual_type: 'chart', visual_query: 'growth chart' },
      { text: 'Beat 2 experiment setup', visual_type: 'stock', visual_query: 'lab workbench' },
      { text: 'Beat 3 breakthrough result', visual_type: 'stock', visual_query: 'spark electric' },
      { text: 'Beat 4 conclusion takeaway', visual_type: 'stock', visual_query: 'sunset horizon' },
    ],
  };

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-batch-visuals-test-'));

    // Create small valid 1-sec 1920x1080 MP4 fixture
    const mp4Path = path.join(tempDir, 'fixture.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=purple:s=1920x1080:d=1',
      '-c:v',
      'libx264',
      mp4Path,
    ]);
    validMp4Buffer = await fs.readFile(mp4Path);

    // Create small valid 1920x1080 PNG fixture
    const pngPath = path.join(tempDir, 'fixture.png');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=orange:s=1920x1080:d=1',
      '-frames:v',
      '1',
      '-update',
      '1',
      pngPath,
    ]);
    validPngBuffer = await fs.readFile(pngPath);
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    // Clean up test uploads directory if created
    const uploadDir = path.join(process.cwd(), 'storage', 'uploads', testVideoId);
    await fs.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
  });

  it('1. extractCandidateNumber detects various naming patterns', () => {
    assert.deepEqual(extractCandidateNumber('beat-0.mp4'), { number: 0, pattern: 'beat' });
    assert.deepEqual(extractCandidateNumber('beat_12.jpg'), { number: 12, pattern: 'beat' });
    assert.deepEqual(extractCandidateNumber('b3.png'), { number: 3, pattern: 'beat' });
    assert.deepEqual(extractCandidateNumber('scene-1.mp4'), { number: 1, pattern: 'scene' });
    assert.deepEqual(extractCandidateNumber('scene_04.mov'), { number: 4, pattern: 'scene' });
    assert.deepEqual(extractCandidateNumber('shot-2.webm'), { number: 2, pattern: 'shot' });
    assert.deepEqual(extractCandidateNumber('01_intro.mp4'), { number: 1, pattern: 'prefix' });
    assert.deepEqual(extractCandidateNumber('nature_05.jpg'), { number: 5, pattern: 'suffix' });
    assert.deepEqual(extractCandidateNumber('07.png'), { number: 7, pattern: 'general' });
    assert.equal(extractCandidateNumber('random_clip_no_digits.mp4'), null);
  });

  it('2. extractBeatIndexFromFilename handles 0-based and 1-based indexing gracefully', () => {
    const totalBeats = 10;

    // Beat 0 is unambiguous 0-based
    assert.equal(extractBeatIndexFromFilename('beat-0.mp4', totalBeats), 0);

    // Explicit beat number within bounds
    assert.equal(extractBeatIndexFromFilename('beat-3.png', totalBeats), 3);

    // Scenes are 1-based human convention -> mapped to 0-based index
    assert.equal(extractBeatIndexFromFilename('scene-1.mp4', totalBeats), 0);
    assert.equal(extractBeatIndexFromFilename('scene-10.mp4', totalBeats), 9);

    // If number equals totalBeats, mapped to totalBeats - 1
    assert.equal(extractBeatIndexFromFilename('clip-10.jpg', totalBeats), 9);

    // Out of bounds numbers return null
    assert.equal(extractBeatIndexFromFilename('beat-99.mp4', totalBeats), null);
    assert.equal(extractBeatIndexFromFilename('unnamed.mp4', totalBeats), null);
  });

  it('3. autoMapFilesToBeats maps files in smart mode and fills gaps sequentially', () => {
    // Fake File-like objects for Node test environment
    const fakeFiles = [
      { name: 'beat-2.mp4', size: 1000, type: 'video/mp4' } as File,
      { name: 'beat-0.jpg', size: 500, type: 'image/jpeg' } as File,
      { name: 'random_image.png', size: 300, type: 'image/png' } as File,
    ];

    const mapped = autoMapFilesToBeats(fakeFiles, 5, { mode: 'smart' });

    assert.equal(mapped.length, 3);
    // Should be sorted by assignedBeatIndex
    assert.equal(mapped[0].fileName, 'beat-0.jpg');
    assert.equal(mapped[0].assignedBeatIndex, 0);

    assert.equal(mapped[1].fileName, 'random_image.png');
    assert.equal(mapped[1].assignedBeatIndex, 1); // filled first available gap

    assert.equal(mapped[2].fileName, 'beat-2.mp4');
    assert.equal(mapped[2].assignedBeatIndex, 2);
  });

  it('4. autoMapFilesToBeats in sequential mode respects skipExisting and startBeat', () => {
    const fakeFiles = [
      { name: 'clipA.mp4', size: 1000, type: 'video/mp4' } as File,
      { name: 'clipB.mp4', size: 1000, type: 'video/mp4' } as File,
    ];

    const existingBeats = new Set([0, 1]); // Beat 0 and 1 already have visuals

    const mapped = autoMapFilesToBeats(fakeFiles, 5, {
      mode: 'sequential',
      startBeat: 0,
      skipExisting: true,
      existingAssetBeatIndices: existingBeats,
    });

    assert.equal(mapped.length, 2);
    assert.equal(mapped[0].assignedBeatIndex, 2); // skipped 0 and 1, assigned to 2
    assert.equal(mapped[1].assignedBeatIndex, 3); // assigned to 3
  });

  it('5. handleBatchVisualUpload API route processes multi-file batch upload', async () => {
    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: testVideoId,
          title: 'Batch Visual Test Video',
          script_json: fiveBeatsScript,
        },
      ],
      video_assets: [],
    });

    const formData = new FormData();
    const mp4Blob = new Blob([validMp4Buffer], { type: 'video/mp4' });
    const pngBlob = new Blob([validPngBuffer], { type: 'image/png' });

    formData.append('file_0', mp4Blob, 'beat-0.mp4');
    formData.append('file_1', pngBlob, 'beat-1.png');
    formData.append('default_license', 'own_work');

    const req = new Request(`http://localhost/api/videos/${testVideoId}/visuals/batch`, {
      method: 'POST',
      body: formData,
    });

    const res = await handleBatchVisualUpload(req, testVideoId, supabase as any);
    assert.equal(res.status, 200);

    const json = await res.json();
    assert.equal(json.total, 2);
    assert.equal(json.successful, 2);
    assert.equal(json.failed, 0);
    assert.equal(json.results.length, 2);
    assert.equal(json.results[0].success, true);
    assert.equal(json.results[0].beatIndex, 0);
    assert.equal(json.results[1].success, true);
    assert.equal(json.results[1].beatIndex, 1);

    // Verify video_assets rows were created in mock database
    assert.equal(db.video_assets.length, 2);
    const asset0 = db.video_assets.find((a: any) => a.beat_index === 0);
    const asset1 = db.video_assets.find((a: any) => a.beat_index === 1);
    assert.ok(asset0);
    assert.equal(asset0.visual_type, 'uploaded');
    assert.ok(asset1);
    assert.equal(asset1.visual_type, 'uploaded');
  });

  it('6. handleBatchVisualUpload returns 404 for nonexistent video', async () => {
    const { supabase } = createMockSupabase({ videos: [] });
    const formData = new FormData();
    formData.append('file_0', new Blob([validPngBuffer], { type: 'image/png' }), 'beat-0.png');

    const req = new Request('http://localhost/api/videos/nonexistent-id/visuals/batch', {
      method: 'POST',
      body: formData,
    });

    const res = await handleBatchVisualUpload(req, 'nonexistent-id', supabase as any);
    assert.equal(res.status, 404);
  });
});
