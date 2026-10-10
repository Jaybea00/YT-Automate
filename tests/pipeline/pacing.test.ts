import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath, getVideoDurationMs } from '../../src/pipeline/utils/ffmpeg';
import { renderBeatScene } from '../../src/pipeline/assembly/assemble-beat';
import { handleGetBgm, handlePostBgm } from '../../src/app/api/videos/[id]/bgm/route';
import { createMockSupabase } from '../helpers/mock-supabase';

const execFileAsync = promisify(execFile);

// Helper to create a test still image (1920x1080)
async function createTestImage(outputPath: string): Promise<void> {
  const ffmpeg = getFfmpegPath();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=purple:s=1920x1080',
    '-vframes', '1',
    outputPath,
  ]);
}

// Helper to generate a dummy 440Hz audible test tone
async function createTestAudio(outputPath: string, durationSec = 2): Promise<void> {
  const ffmpeg = getFfmpegPath();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(durationSec),
    '-c:a', 'aac',
    outputPath,
  ]);
}

test('Beat Pacing & Breathing Room Pipeline Tests', async (t) => {
  const tempDir = path.join(process.cwd(), 'storage', 'test_pacing');
  await fs.mkdir(tempDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('1. renderBeatScene with pauseSeconds: 0.5 extends scene duration by 500ms with silence padding', async () => {
    const imgPath = path.join(tempDir, 'test_img.png');
    const audioPath = path.join(tempDir, 'audio_2s.aac');
    const outPath = path.join(tempDir, 'out_padded_500ms.mp4');

    await createTestImage(imgPath);
    await createTestAudio(audioPath, 2.0);

    await renderBeatScene({
      visualPath: imgPath,
      audioPath,
      durationMs: 2000,
      outputPath: outPath,
      isVideo: false,
      pauseSeconds: 0.5,
    });

    const stat = await fs.stat(outPath);
    assert.ok(stat.size > 0, 'Padded video must exist and be non-empty');

    const durationMs = await getVideoDurationMs(outPath);
    assert.ok(
      Math.abs(durationMs - 2500) <= 200,
      `Padded video duration (${durationMs}ms) must match audio duration + pause (2500ms)`,
    );
  });

  await t.test('2. renderBeatScene with pauseSeconds: 0 maintains exact base duration', async () => {
    const imgPath = path.join(tempDir, 'test_img.png');
    const audioPath = path.join(tempDir, 'audio_2s.aac');
    const outPath = path.join(tempDir, 'out_unpadded.mp4');

    await renderBeatScene({
      visualPath: imgPath,
      audioPath,
      durationMs: 2000,
      outputPath: outPath,
      isVideo: false,
      pauseSeconds: 0,
    });

    const durationMs = await getVideoDurationMs(outPath);
    assert.ok(
      Math.abs(durationMs - 2000) <= 200,
      `Unpadded video duration (${durationMs}ms) must match exact base duration (2000ms)`,
    );
  });

  await t.test('3. handleGetBgm returns default beatPauseSeconds = 0.5', async () => {
    const { supabase } = createMockSupabase({
      videos: [
        {
          id: 'pacing-video-1',
          bgm_enabled: true,
          bgm_track: 'lofi',
          bgm_volume: 0.2,
          script_json: {},
        },
      ],
    });

    const req = new Request('http://localhost/api/videos/pacing-video-1/bgm', { method: 'GET' });
    const res = await handleGetBgm(req, 'pacing-video-1', supabase as any);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.beatPauseSeconds, 0.5);
  });

  await t.test('4. handlePostBgm updates and persists custom beatPauseSeconds', async () => {
    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: 'pacing-video-2',
          bgm_enabled: true,
          bgm_track: 'lofi',
          bgm_volume: 0.2,
          script_json: {},
        },
      ],
    });

    const req = new Request('http://localhost/api/videos/pacing-video-2/bgm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        beatPauseSeconds: 0.8,
      }),
    });

    const res = await handlePostBgm(req, 'pacing-video-2', supabase as any);
    assert.equal(res.status, 200);

    const updatedVideo = db.videos.find((v) => v.id === 'pacing-video-2');
    assert.ok(updatedVideo);
    assert.equal(updatedVideo.script_json.beat_pause_seconds, 0.8);
  });
});
