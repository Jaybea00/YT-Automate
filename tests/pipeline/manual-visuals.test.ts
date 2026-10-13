import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { handleVisualUpload, handleGetVisual } from '../../src/app/api/videos/[id]/beats/[index]/visual/route';
import { handleAssemblyRequest } from '../../src/app/api/videos/[id]/assembly/route';
import { handleVoiceRequest } from '../../src/app/api/videos/[id]/voice/route';
import { checkAssemblyGate } from '../../src/pipeline/assembly/gate';
import { sourceVisualBeat } from '../../src/pipeline/visuals/beat-sourcer';
import { createMockSupabase } from '../helpers/mock-supabase';

const execFileAsync = promisify(execFile);

describe('Part 1: Manual Visual Upload & Assembly Gate', () => {
  let tempDir: string;
  let validMp4Buffer: Buffer;
  let squareImgBuffer: Buffer;
  let validPngBuffer: Buffer;

  const testVideoId = '11111111-2222-3333-4444-555555555555';
  const threeBeatsScript = {
    beats: [
      { text: 'Beat 0 narration text', visual_type: 'stock', visual_query: 'nature forest' },
      { text: 'Beat 1 narration text', visual_type: 'chart', visual_query: 'growth chart' },
      { text: 'Beat 2 narration text', visual_type: 'screen_recording', visual_query: 'github repo' },
    ],
  };

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-manual-visuals-test-'));

    // Generate small valid 1920x1080 1-second MP4 fixture using ffmpeg lavfi
    const mp4Path = path.join(tempDir, 'fixture_1080p.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=1920x1080:d=1',
      '-c:v',
      'libx264',
      mp4Path,
    ]);
    validMp4Buffer = await fs.readFile(mp4Path);

    // Generate small 16:9 PNG fixture using ffmpeg
    const pngPath = path.join(tempDir, 'fixture_16_9.png');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=1920x1080:d=1',
      '-frames:v',
      '1',
      '-update',
      '1',
      pngPath,
    ]);
    validPngBuffer = await fs.readFile(pngPath);

    // Generate non-16:9 (1:1 square) image fixture to test aspect ratio warning
    const squarePath = path.join(tempDir, 'fixture_square.png');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=500x500:d=1',
      '-frames:v',
      '1',
      '-update',
      '1',
      squarePath,
    ]);
    squareImgBuffer = await fs.readFile(squarePath);
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    // Clean up any test uploads created under storage/uploads/<testVideoId>
    const uploadsDir = path.join(process.cwd(), 'storage', 'uploads', testVideoId);
    await fs.rm(uploadsDir, { recursive: true, force: true }).catch(() => {});
  });

  // --------------------------------------------------------------------------
  // TEST SUITE 1: UPLOAD VALIDATION
  // --------------------------------------------------------------------------
  describe('Upload Validation', () => {
    it('rejects un-sniffable bad file type even if given an .mp4 extension', async () => {
      const { supabase } = createMockSupabase({
        videos: [{ id: testVideoId, script_json: threeBeatsScript }],
      });

      const badFormData = new FormData();
      const fakeTextBlob = new Blob(['Not a video file; just random text contents'], {
        type: 'video/mp4',
      });
      badFormData.append('file', fakeTextBlob, 'corrupt.mp4');
      badFormData.append('license_type', 'own_work');

      const req = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/0/visual`, {
        method: 'POST',
        body: badFormData,
      });

      const res = await handleVisualUpload(req, testVideoId, '0', supabase);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /content sniffing/i);
    });

    it('rejects oversize uploads exceeding maximum size limit', async () => {
      const { supabase } = createMockSupabase({
        videos: [{ id: testVideoId, script_json: threeBeatsScript }],
      });

      // Temporarily set max upload size to 100 bytes
      const origEnv = process.env.MAX_UPLOAD_SIZE_BYTES;
      process.env.MAX_UPLOAD_SIZE_BYTES = '100';

      try {
        const formData = new FormData();
        const fileBlob = new Blob([validMp4Buffer], { type: 'video/mp4' });
        formData.append('file', fileBlob, 'video.mp4');
        formData.append('license_type', 'own_work');

        const req = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/0/visual`, {
          method: 'POST',
          body: formData,
        });

        const res = await handleVisualUpload(req, testVideoId, '0', supabase);
        assert.equal(res.status, 400);
        const json = await res.json();
        assert.match(json.error, /exceeds allowed limit/i);
      } finally {
        process.env.MAX_UPLOAD_SIZE_BYTES = origEnv;
      }
    });

    it('rejects corrupt binary file when ffprobe cannot parse media streams', async () => {
      const { supabase } = createMockSupabase({
        videos: [{ id: testVideoId, script_json: threeBeatsScript }],
      });

      // Craft buffer with valid PNG magic bytes but corrupt payload
      const corruptPng = Buffer.alloc(50);
      corruptPng[0] = 0x89;
      corruptPng[1] = 0x50;
      corruptPng[2] = 0x4e;
      corruptPng[3] = 0x47;
      corruptPng[4] = 0x0d;
      corruptPng[5] = 0x0a;
      corruptPng[6] = 0x1a;
      corruptPng[7] = 0x0a;

      const formData = new FormData();
      const fileBlob = new Blob([corruptPng], { type: 'image/png' });
      formData.append('file', fileBlob, 'corrupt.png');
      formData.append('license_type', 'own_work');

      const req = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/0/visual`, {
        method: 'POST',
        body: formData,
      });

      const res = await handleVisualUpload(req, testVideoId, '0', supabase);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /ffprobe/i);
    });

    it('rejects license cc_by when attribution_text is missing', async () => {
      const { supabase } = createMockSupabase({
        videos: [{ id: testVideoId, script_json: threeBeatsScript }],
      });

      const formData = new FormData();
      const fileBlob = new Blob([validPngBuffer], { type: 'image/png' });
      formData.append('file', fileBlob, 'beat-0.png');
      formData.append('license_type', 'cc_by');
      // attribution_text omitted

      const req = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/0/visual`, {
        method: 'POST',
        body: formData,
      });

      const res = await handleVisualUpload(req, testVideoId, '0', supabase);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /attribution_text is required/i);
    });

    it('returns warnings when video is shorter than TTS duration and aspect ratio is non-16:9', async () => {
      const { supabase } = createMockSupabase({
        videos: [{ id: testVideoId, script_json: threeBeatsScript }],
        yt_jobs: [{ id: 'job-1', video_id: testVideoId, created_at: new Date().toISOString() }],
        yt_job_units: [
          // TTS unit measured duration is 8,000ms (8 seconds)
          { job_id: 'job-1', stage: 'tts', unit_index: 0, status: 'done', duration_ms: 8000 },
        ],
      });

      // 1. Upload validMp4Buffer (duration is 1s, less than 8s TTS duration)
      const formData = new FormData();
      const fileBlob = new Blob([validMp4Buffer], { type: 'video/mp4' });
      formData.append('file', fileBlob, 'short_video.mp4');
      formData.append('license_type', 'own_work');

      const req = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/0/visual`, {
        method: 'POST',
        body: formData,
      });

      const res = await handleVisualUpload(req, testVideoId, '0', supabase);
      assert.equal(res.status, 200);
      const json = await res.json();

      // Should contain duration warning
      assert.ok(json.warnings.length > 0);
      assert.ok(
        json.warnings.some((w: string) => /shorter than beat.*TTS duration/i.test(w)),
        `Expected shorter than TTS warning in ${JSON.stringify(json.warnings)}`,
      );

      // 2. Upload square 1:1 image to test non-16:9 warning
      const formDataSquare = new FormData();
      const squareBlob = new Blob([squareImgBuffer], { type: 'image/png' });
      formDataSquare.append('file', squareBlob, 'square.png');
      formDataSquare.append('license_type', 'purchased');

      const reqSquare = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/0/visual`, {
        method: 'POST',
        body: formDataSquare,
      });

      const resSquare = await handleVisualUpload(reqSquare, testVideoId, '0', supabase);
      assert.equal(resSquare.status, 200);
      const jsonSquare = await resSquare.json();

      assert.ok(
        jsonSquare.warnings.some((w: string) => /not 16:9/i.test(w)),
        `Expected non-16:9 warning in ${JSON.stringify(jsonSquare.warnings)}`,
      );
    });
  });

  // --------------------------------------------------------------------------
  // TEST SUITE 2: RE-UPLOAD REPLACES FILE AND ROW
  // --------------------------------------------------------------------------
  describe('Re-upload Replaces File and video_assets Row', () => {
    it('replaces existing file and updates video_assets row upon re-upload', async () => {
      const { supabase, db } = createMockSupabase({
        videos: [{ id: testVideoId, script_json: threeBeatsScript }],
      });

      const uploadsDir = path.join(process.cwd(), 'storage', 'uploads', testVideoId);

      // 1. Initial upload: upload PNG image for beat 0
      const formData1 = new FormData();
      const pngBlob = new Blob([validPngBuffer], { type: 'image/png' });
      formData1.append('file', pngBlob, 'initial.png');
      formData1.append('license_type', 'own_work');
      formData1.append('source_note', 'original camera photo');

      const req1 = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/0/visual`, {
        method: 'POST',
        body: formData1,
      });

      const res1 = await handleVisualUpload(req1, testVideoId, '0', supabase);
      assert.equal(res1.status, 200);

      // Verify PNG file was stored on disk
      const pngPath = path.join(uploadsDir, 'beat-0.png');
      const pngStat = await fs.stat(pngPath).catch(() => null);
      assert.ok(pngStat?.isFile(), 'Expected beat-0.png to exist on disk');

      // Verify row in video_assets
      assert.equal(db.video_assets.length, 1);
      assert.equal(db.video_assets[0].visual_type, 'uploaded');
      assert.equal(db.video_assets[0].license_type, 'own_work');
      // source_url holds the stored file path, which assembly reads the visual from
      assert.equal(db.video_assets[0].source_url, pngPath);

      // 2. Re-upload: replace with MP4 video for beat 0 with new license & note
      const formData2 = new FormData();
      const mp4Blob = new Blob([validMp4Buffer], { type: 'video/mp4' });
      formData2.append('file', mp4Blob, 'replacement.mp4');
      formData2.append('license_type', 'cc_by');
      formData2.append('attribution_text', 'Filmed by John Doe');
      formData2.append('source_note', 'https://example.com/video');

      const req2 = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/0/visual`, {
        method: 'POST',
        body: formData2,
      });

      const res2 = await handleVisualUpload(req2, testVideoId, '0', supabase);
      assert.equal(res2.status, 200);

      // Verify old PNG file was DELETED from disk
      const pngAfter = await fs.stat(pngPath).catch(() => null);
      assert.equal(pngAfter, null, 'Expected old beat-0.png to be deleted');

      // Verify new MP4 file was stored
      const mp4Path = path.join(uploadsDir, 'beat-0.mp4');
      const mp4Stat = await fs.stat(mp4Path).catch(() => null);
      assert.ok(mp4Stat?.isFile(), 'Expected new beat-0.mp4 to exist');

      // Verify video_assets row updated
      assert.equal(db.video_assets.length, 1);
      assert.equal(db.video_assets[0].visual_type, 'uploaded');
      assert.equal(db.video_assets[0].license_type, 'cc_by');
      assert.equal(db.video_assets[0].attribution_text, 'Filmed by John Doe');
      assert.equal(db.video_assets[0].source_url, mp4Path);
    });
  });

  // --------------------------------------------------------------------------
  // TEST SUITE 3: ASSEMBLY GATE LISTS MISSING BEATS
  // --------------------------------------------------------------------------
  describe('Assembly Gate', () => {
    it('refuses to start when beats are missing assets, listing all missing indexes (400)', async () => {
      // 3 beats script, only beat 0 has an asset; beats 1 and 2 are missing
      const { supabase } = createMockSupabase({
        videos: [{ id: testVideoId, script_json: threeBeatsScript }],
        video_assets: [
          { video_id: testVideoId, beat_index: 0, visual_type: 'uploaded' },
        ],
      });

      // Test checkAssemblyGate directly
      const gate = await checkAssemblyGate(supabase, testVideoId);
      assert.equal(gate.ready, false);
      assert.equal(gate.status, 400);
      assert.deepEqual(gate.missingBeats, [1, 2]);
      assert.match(gate.error || '', /missing visual assets for beats \[1, 2\]/i);

      // Test POST /api/videos/[id]/assembly
      const reqAssembly = new Request(`http://localhost:3000/api/videos/${testVideoId}/assembly`, {
        method: 'POST',
      });
      const resAssembly = await handleAssemblyRequest(reqAssembly, testVideoId, supabase);
      assert.equal(resAssembly.status, 400);
      const jsonAssembly = await resAssembly.json();
      assert.deepEqual(jsonAssembly.missingBeats, [1, 2]);

      // Test POST /api/videos/[id]/voice with stages: ['assembly']
      const reqVoice = new Request(`http://localhost:3000/api/videos/${testVideoId}/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stages: ['assembly'] }),
      });
      const resVoice = await handleVoiceRequest(reqVoice, testVideoId, supabase);
      assert.equal(resVoice.status, 400);
      const jsonVoice = await resVoice.json();
      assert.deepEqual(jsonVoice.missingBeats, [1, 2]);
    });

    it('passes gate when every beat has an asset', async () => {
      // All 3 beats have an asset
      const { supabase, db } = createMockSupabase({
        videos: [{ id: testVideoId, script_json: threeBeatsScript }],
        video_assets: [
          { video_id: testVideoId, beat_index: 0, visual_type: 'uploaded' },
          { video_id: testVideoId, beat_index: 1, visual_type: 'uploaded' },
          { video_id: testVideoId, beat_index: 2, visual_type: 'uploaded' },
        ],
      });

      const gate = await checkAssemblyGate(supabase, testVideoId);
      assert.equal(gate.ready, true);
      assert.deepEqual(gate.missingBeats, []);

      const reqAssembly = new Request(`http://localhost:3000/api/videos/${testVideoId}/assembly`, {
        method: 'POST',
      });
      const resAssembly = await handleAssemblyRequest(reqAssembly, testVideoId, supabase);
      assert.equal(resAssembly.status, 201);
      assert.equal(db.yt_jobs.length, 1);
      assert.deepEqual(db.yt_jobs[0].stages, ['assembly']);
    });
  });

  // --------------------------------------------------------------------------
  // TEST SUITE 4: AUTO VISUALS NEVER OVERWRITES AN UPLOAD
  // --------------------------------------------------------------------------
  describe('Auto Visuals Sourcing Skip', () => {
    it('skips auto-sourcing when video_assets row has visual_type uploaded and leaves row untouched', async () => {
      let stockProviderCalled = false;
      const dummyStockProvider: any = {
        id: 'pixabay',
        searchVideos: async () => {
          stockProviderCalled = true;
          return [];
        },
      };

      const initialAsset = {
        video_id: testVideoId,
        beat_index: 0,
        visual_type: 'uploaded',
        source_url: 'custom_filmed_b_roll.mp4',
        license_type: 'own_work',
        license_source: 'manual_upload',
        attribution_text: 'Owner direct recording',
        license_proof_url: null,
      };

      const { supabase, db } = createMockSupabase({
        videos: [{ id: testVideoId, script_json: threeBeatsScript }],
        video_assets: [{ ...initialAsset }],
      });

      const outputDir = path.join(tempDir, 'auto_visuals_test');
      await fs.mkdir(outputDir, { recursive: true });

      const result = await sourceVisualBeat({
        jobId: 'job-xyz',
        videoId: testVideoId,
        beat: {
          index: 0,
          text: 'Beat 0 narration text',
          visual_type: 'stock', // auto pipeline attempts stock sourcing
          visual_query: 'nature',
        },
        targetDurationMs: 5000,
        outputDir,
        supabase,
        stockProvider: dummyStockProvider,
        stockCtx: { baseUrl: 'https://example.com' },
      });

      // Stock provider must NOT be called
      assert.equal(stockProviderCalled, false, 'Stock provider must not be called for uploaded beat');
      assert.equal(result.finalVisualType, 'uploaded');

      // The video_assets row must be UNTOUCHED
      assert.equal(db.video_assets.length, 1);
      const asset = db.video_assets[0];
      assert.equal(asset.visual_type, 'uploaded');
      assert.equal(asset.source_url, 'custom_filmed_b_roll.mp4');
      assert.equal(asset.license_type, 'own_work');
      assert.equal(asset.attribution_text, 'Owner direct recording');
    });
  });

  // --------------------------------------------------------------------------
  // TEST SUITE 5: GET ROUTE SERVES WITH RANGE REQUESTS
  // --------------------------------------------------------------------------
  describe('GET /api/videos/[id]/beats/[index]/visual', () => {
    it('serves uploaded file with 200 OK and supports HTTP 206 Partial Content Range requests', async () => {
      const { supabase } = createMockSupabase({
        videos: [{ id: testVideoId, script_json: threeBeatsScript }],
      });

      // Upload file for beat 1
      const formData = new FormData();
      const mp4Blob = new Blob([validMp4Buffer], { type: 'video/mp4' });
      formData.append('file', mp4Blob, 'test_range.mp4');
      formData.append('license_type', 'own_work');

      const uploadReq = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/1/visual`, {
        method: 'POST',
        body: formData,
      });
      const uploadRes = await handleVisualUpload(uploadReq, testVideoId, '1', supabase);
      assert.equal(uploadRes.status, 200);

      // GET full file (200 OK)
      const getReq = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/1/visual`);
      const getRes = await handleGetVisual(getReq, testVideoId, '1', supabase);
      assert.equal(getRes.status, 200);
      assert.equal(getRes.headers.get('Content-Type'), 'video/mp4');
      assert.equal(getRes.headers.get('Accept-Ranges'), 'bytes');

      // GET with Range header (206 Partial Content)
      const rangeReq = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/1/visual`, {
        headers: { Range: 'bytes=0-99' },
      });
      const rangeRes = await handleGetVisual(rangeReq, testVideoId, '1', supabase);
      assert.equal(rangeRes.status, 206);
      assert.equal(rangeRes.headers.get('Content-Type'), 'video/mp4');
      assert.equal(rangeRes.headers.get('Content-Length'), '100');
      assert.match(rangeRes.headers.get('Content-Range') || '', /^bytes 0-99\/\d+$/);

      // GET non-existent beat returns 404
      const notFoundReq = new Request(`http://localhost:3000/api/videos/${testVideoId}/beats/99/visual`);
      const notFoundRes = await handleGetVisual(notFoundReq, testVideoId, '99', supabase);
      assert.equal(notFoundRes.status, 404);
    });
  });
});
