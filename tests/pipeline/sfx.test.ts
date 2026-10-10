import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath, getVideoDurationMs } from '../../src/pipeline/utils/ffmpeg';
import { renderBeatScene } from '../../src/pipeline/assembly/assemble-beat';
import {
  ensureDefaultSfxPresets,
  resolveSfxPath,
  PRESET_SFX,
} from '../../src/pipeline/assembly/sfx';
import { handleGetBgm, handlePostBgm } from '../../src/app/api/videos/[id]/bgm/route';
import { GET as handleGetSfxPreset } from '../../src/app/api/sfx/presets/[track]/route';

const execFileAsync = promisify(execFile);

// Helper to create dummy test image (1920x1080)
async function createTestImage(outputPath: string, width = 1920, height = 1080): Promise<void> {
  const ffmpeg = getFfmpegPath();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=navy:s=${width}x${height}`,
    '-vframes', '1',
    outputPath,
  ]);
}

// Helper to generate a dummy 440Hz audible test tone of durationSec
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

test('Transition Sound Effects (SFX) Pipeline Tests', async (t) => {
  const tempDir = path.join(process.cwd(), 'storage', 'test_sfx_suite');
  await fs.mkdir(tempDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('1. ensureDefaultSfxPresets synthesizes offline preset tracks', async () => {
    await ensureDefaultSfxPresets();

    const presetsDir = path.join(process.cwd(), 'storage', 'sfx', 'presets');
    for (const preset of PRESET_SFX) {
      if (preset.id === 'none') continue;
      const filePath = path.join(presetsDir, `${preset.id}.mp3`);
      const stat = await fs.stat(filePath);
      assert.ok(stat.size > 0, `Preset ${preset.id}.mp3 must exist and be non-empty`);
    }
  });

  await t.test('2. resolveSfxPath resolves paths for presets and ignores none', async () => {
    const whooshPath = await resolveSfxPath('whoosh');
    assert.ok(whooshPath && whooshPath.endsWith('whoosh.mp3'), 'Must resolve whoosh path');

    const clickPath = await resolveSfxPath('click');
    assert.ok(clickPath && clickPath.endsWith('click.mp3'), 'Must resolve click path');

    const nonePath = await resolveSfxPath('none');
    assert.equal(nonePath, null, 'none track must return null');
  });

  await t.test('3. renderBeatScene blends SFX audio with voiceover preserving exact duration', async () => {
    const imgPath = path.join(tempDir, 'test_img_sfx.png');
    const audioPath = path.join(tempDir, 'voice_2s.aac');
    const outPath = path.join(tempDir, 'out_beat_with_sfx.mp4');

    await createTestImage(imgPath);
    await createTestAudio(audioPath, 2.0);

    const whooshPath = await resolveSfxPath('whoosh');
    assert.ok(whooshPath, 'Whoosh SFX must exist');

    await renderBeatScene({
      visualPath: imgPath,
      audioPath,
      durationMs: 2000,
      outputPath: outPath,
      isVideo: false,
      sfxPath: whooshPath,
      sfxVolume: 0.25,
      padStyle: 'blur',
    });

    const stat = await fs.stat(outPath);
    assert.ok(stat.size > 0, 'Video with SFX must be rendered and non-empty');

    const durationMs = await getVideoDurationMs(outPath);
    assert.ok(
      Math.abs(durationMs - 2000) <= 200,
      `Duration (${durationMs}ms) must remain strictly locked to narration duration (2000ms)`,
    );
  });

  await t.test('4. GET /api/sfx/presets/[track] serves SFX audio with HTTP 206 support', async () => {
    // 1. Full file request (200 OK)
    const fullReq = new Request('http://localhost:3000/api/sfx/presets/whoosh');
    const fullRes = await handleGetSfxPreset(fullReq, { params: Promise.resolve({ track: 'whoosh' }) });
    assert.equal(fullRes.status, 200);
    assert.equal(fullRes.headers.get('Content-Type'), 'audio/mpeg');

    // 2. Partial content Range request (206 Partial Content)
    const rangeReq = new Request('http://localhost:3000/api/sfx/presets/whoosh', {
      headers: { Range: 'bytes=0-1023' },
    });
    const rangeRes = await handleGetSfxPreset(rangeReq, { params: Promise.resolve({ track: 'whoosh' }) });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('Content-Range'), 'bytes 0-1023/' + fullRes.headers.get('Content-Length'));
  });

  await t.test('5. GET & POST /api/videos/[id]/bgm persists SFX settings in script_json.sfx', async () => {
    const mockDbVideo = {
      id: 'sfx-video-1',
      bgm_track: 'lofi',
      bgm_volume: 0.2,
      bgm_enabled: true,
      script_json: {
        sfx: {
          enabled: true,
          track: 'whoosh',
          volume: 0.25,
        },
      },
    };

    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: mockDbVideo, error: null }),
            single: async () => ({ data: mockDbVideo, error: null }),
          }),
        }),
        update: (payload: any) => ({
          eq: async () => {
            if (payload.script_json) {
              mockDbVideo.script_json = payload.script_json;
            }
            return { error: null };
          },
        }),
      }),
    } as any;

    // 1. Initial GET
    const getReq = new Request('http://localhost:3000/api/videos/sfx-video-1/bgm');
    const getRes = await handleGetBgm(getReq, 'sfx-video-1', mockSupabase);
    const getJson = await getRes.json();
    assert.equal(getJson.sfx.track, 'whoosh');
    assert.equal(getJson.sfx.volume, 0.25);

    // 2. POST update to click with 0.35 volume
    const postReq = new Request('http://localhost:3000/api/videos/sfx-video-1/bgm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sfxTrack: 'click',
        sfxVolume: 0.35,
        sfxEnabled: true,
      }),
    });
    const postRes = await handlePostBgm(postReq, 'sfx-video-1', mockSupabase);
    const postJson = await postRes.json();
    assert.equal(postJson.success, true);
    assert.equal(postJson.sfx.track, 'click');
    assert.equal(postJson.sfx.volume, 0.35);

    // 3. Subsequent GET confirms persistence
    const getRes2 = await handleGetBgm(getReq, 'sfx-video-1', mockSupabase);
    const getJson2 = await getRes2.json();
    assert.equal(getJson2.sfx.track, 'click');
    assert.equal(getJson2.sfx.volume, 0.35);
  });
});
