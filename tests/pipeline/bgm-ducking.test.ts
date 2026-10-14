import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ensureDefaultBgmPresets,
  resolveBgmTrackPath,
  applyBackgroundMusic,
} from '../../src/pipeline/assembly/bgm.ts';
import {
  getFfmpegPath,
  getVideoDurationMs,
} from '../../src/pipeline/utils/ffmpeg.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';
import { handleGetBgm, handlePostBgm } from '../../src/app/api/videos/[id]/bgm/route.ts';

const execFileAsync = promisify(execFile);

describe('Background Music & Auto-Ducking Tests', () => {
  let tempDir: string;
  let testVideo: string;
  let testBgm: string;
  const ffmpegBin = getFfmpegPath();

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-bgm-test-'));
    testVideo = path.join(tempDir, 'voice_video.mp4');
    testBgm = path.join(tempDir, 'test_bgm.mp3');

    // 1. Generate 2.0s video with speech-like tone
    await execFileAsync(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '2.0',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      testVideo,
    ]);

    // 2. Generate 3.0s test BGM track
    await execFileAsync(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=180:sample_rate=48000',
      '-t',
      '3.0',
      '-c:a',
      'libmp3lame',
      testBgm,
    ]);
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('1. ensureDefaultBgmPresets generates offline synth preset tracks if absent', async () => {
    await ensureDefaultBgmPresets();

    const presetsDir = path.join(process.cwd(), 'storage', 'bgm', 'presets');
    const lofiExists = await fs
      .stat(path.join(presetsDir, 'lofi.mp3'))
      .then((s) => s.isFile() && s.size > 0);
    const ambientExists = await fs
      .stat(path.join(presetsDir, 'ambient.mp3'))
      .then((s) => s.isFile() && s.size > 0);
    const techExists = await fs
      .stat(path.join(presetsDir, 'tech.mp3'))
      .then((s) => s.isFile() && s.size > 0);

    assert.equal(lofiExists, true);
    assert.equal(ambientExists, true);
    assert.equal(techExists, true);
  });

  it('2. resolveBgmTrackPath correctly resolves preset files and ignores "none"', async () => {
    const lofiPath = await resolveBgmTrackPath({ track: 'lofi' });
    assert.ok(lofiPath && lofiPath.endsWith('lofi.mp3'));

    const nonePath = await resolveBgmTrackPath({ track: 'none' });
    assert.equal(nonePath, null);

    const emptyPath = await resolveBgmTrackPath({ track: '' });
    assert.equal(emptyPath, null);
  });

  it('3. applyBackgroundMusic mixes ducked BGM and preserves exact video duration', async () => {
    const duckedOut = path.join(tempDir, 'ducked_output.mp4');

    await applyBackgroundMusic({
      videoPath: testVideo,
      bgmPath: testBgm,
      outputPath: duckedOut,
      volume: 0.25,
      duckingThreshold: 0.08,
      duckingRatio: 4,
    });

    const exists = await fs.stat(duckedOut).then((s) => s.isFile() && s.size > 0);
    assert.ok(exists, 'Ducked video output must exist');

    const durationMs = await getVideoDurationMs(duckedOut);
    // Original video was 2.0s (2000ms)
    assert.ok(
      Math.abs(durationMs - 2000) <= 150,
      `Duration ${durationMs}ms should match video duration ~2000ms`,
    );
  });

  it('4. POST & GET /api/videos/[id]/bgm updates and reads video BGM configuration', async () => {
    const videoId = 'vid-bgm-cfg-test';
    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: videoId,
          title: 'BGM Test',
          bgm_enabled: true,
          bgm_track: 'lofi',
          bgm_volume: 0.2,
          script_json: {},
        },
      ],
    });

    // 1. GET initial
    const getReq = new Request(`http://localhost:3000/api/videos/${videoId}/bgm`);
    const getRes = await handleGetBgm(getReq, videoId, supabase);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.bgm.track, 'lofi');
    assert.equal(getData.bgm.enabled, true);

    // 2. POST update to ambient at 0.15 volume
    const postReq = new Request(`http://localhost:3000/api/videos/${videoId}/bgm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        track: 'ambient',
        volume: 0.15,
      }),
    });

    const postRes = await handlePostBgm(postReq, videoId, supabase);
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(postData.bgm.track, 'ambient');
    assert.equal(postData.bgm.volume, 0.15);

    // Verify DB updated
    const vRec = db.videos.find((v) => v.id === videoId);
    assert.equal(vRec?.bgm_track, 'ambient');
    assert.equal(vRec?.bgm_volume, 0.15);
  });
});
