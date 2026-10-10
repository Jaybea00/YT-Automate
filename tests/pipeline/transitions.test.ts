import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath, getVideoDurationMs } from '../../src/pipeline/utils/ffmpeg';
import { renderBeatScene, concatenateSceneClips } from '../../src/pipeline/assembly/assemble-beat';
import { handleGetBgm, handlePostBgm } from '../../src/app/api/videos/[id]/bgm/route';

const execFileAsync = promisify(execFile);

// Helper to create dummy test image (1920x1080)
async function createTestImage(outputPath: string, width = 1920, height = 1080): Promise<void> {
  const ffmpeg = getFfmpegPath();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=purple:s=${width}x${height}`,
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

// Helper to create dummy test video clip
async function createTestClip(outputPath: string, color = 'blue', durationSec = 2): Promise<void> {
  const ffmpeg = getFfmpegPath();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(ffmpeg, [
    '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=1920x1080:d=${durationSec}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:d=${durationSec}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    outputPath,
  ]);
}

test('Scene-to-Scene Transitions Pipeline Tests', async (t) => {
  const tempDir = path.join(process.cwd(), 'storage', 'test_transitions_suite');
  await fs.mkdir(tempDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('1. renderBeatScene applies Dip to Black on still image', async () => {
    const imgPath = path.join(tempDir, 'test_img1.png');
    const audioPath = path.join(tempDir, 'audio_dip_black.aac');
    const outPath = path.join(tempDir, 'out_dip_black.mp4');

    await createTestImage(imgPath);
    await createTestAudio(audioPath, 2.0);

    await renderBeatScene({
      visualPath: imgPath,
      audioPath,
      durationMs: 2000,
      outputPath: outPath,
      isVideo: false,
      transition: 'dip_black',
      padStyle: 'blur',
    });

    const stat = await fs.stat(outPath);
    assert.ok(stat.size > 0, 'Dip to black output video must exist and be non-empty');

    const durationMs = await getVideoDurationMs(outPath);
    assert.ok(
      Math.abs(durationMs - 2000) <= 200,
      `Video duration (${durationMs}ms) must match exact target duration (2000ms)`,
    );
  });

  await t.test('2. renderBeatScene applies Flash to White on still image', async () => {
    const imgPath = path.join(tempDir, 'test_img2.png');
    const audioPath = path.join(tempDir, 'audio_dip_white.aac');
    const outPath = path.join(tempDir, 'out_dip_white.mp4');

    await createTestImage(imgPath);
    await createTestAudio(audioPath, 2.0);

    await renderBeatScene({
      visualPath: imgPath,
      audioPath,
      durationMs: 2000,
      outputPath: outPath,
      isVideo: false,
      transition: 'dip_white',
      padStyle: 'black',
    });

    const stat = await fs.stat(outPath);
    assert.ok(stat.size > 0, 'Dip to white output video must exist and be non-empty');

    const durationMs = await getVideoDurationMs(outPath);
    assert.ok(
      Math.abs(durationMs - 2000) <= 200,
      `Video duration (${durationMs}ms) must match exact target duration (2000ms)`,
    );
  });

  await t.test('3. concatenateSceneClips concatenates clips with fast cut (stream copy)', async () => {
    const c1 = path.join(tempDir, 'c1_cut.mp4');
    const c2 = path.join(tempDir, 'c2_cut.mp4');
    const outCut = path.join(tempDir, 'out_cut.mp4');

    await createTestClip(c1, 'red', 2);
    await createTestClip(c2, 'blue', 2);

    await concatenateSceneClips([c1, c2], outCut, tempDir, { transition: 'cut' });

    const stat = await fs.stat(outCut);
    assert.ok(stat.size > 0, 'Cut concat output must exist');

    const durationMs = await getVideoDurationMs(outCut);
    assert.ok(
      Math.abs(durationMs - 4000) <= 300,
      `Total duration (${durationMs}ms) must equal sum of clips (4000ms)`,
    );
  });

  await t.test('4. concatenateSceneClips concatenates clips with crossfade (xfade)', async () => {
    const c1 = path.join(tempDir, 'c1_xfade.mp4');
    const c2 = path.join(tempDir, 'c2_xfade.mp4');
    const outXfade = path.join(tempDir, 'out_xfade.mp4');

    await createTestClip(c1, 'green', 2);
    await createTestClip(c2, 'purple', 2);

    await concatenateSceneClips([c1, c2], outXfade, tempDir, {
      transition: 'crossfade',
      transitionDuration: 0.5,
    });

    const stat = await fs.stat(outXfade);
    assert.ok(stat.size > 0, 'Crossfade concat output must exist');

    const durationMs = await getVideoDurationMs(outXfade);
    // 2s + 2s - 0.5s transition = 3.5s
    assert.ok(
      Math.abs(durationMs - 3500) <= 300,
      `Crossfaded duration (${durationMs}ms) should match expected overlap (~3500ms)`,
    );
  });

  await t.test('5. concatenateSceneClips concatenates clips with wipe transition', async () => {
    const c1 = path.join(tempDir, 'c1_wipe.mp4');
    const c2 = path.join(tempDir, 'c2_wipe.mp4');
    const outWipe = path.join(tempDir, 'out_wipe.mp4');

    await createTestClip(c1, 'orange', 2);
    await createTestClip(c2, 'teal', 2);

    await concatenateSceneClips([c1, c2], outWipe, tempDir, {
      transition: 'wipe',
      transitionDuration: 0.5,
    });

    const stat = await fs.stat(outWipe);
    assert.ok(stat.size > 0, 'Wipe concat output must exist');
  });

  await t.test('6. GET & POST /api/videos/[id]/bgm updates and retrieves transition setting', async () => {
    const mockDbVideo = {
      id: 'trans-video-1',
      bgm_track: 'lofi',
      bgm_volume: 0.2,
      bgm_enabled: true,
      script_json: {
        transition: 'cut',
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
    const getReq = new Request('http://localhost:3000/api/videos/trans-video-1/bgm');
    const getRes = await handleGetBgm(getReq, 'trans-video-1', mockSupabase);
    const getJson = await getRes.json();
    assert.equal(getJson.transition, 'cut');

    // 2. POST update to dip_black
    const postReq = new Request('http://localhost:3000/api/videos/trans-video-1/bgm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transition: 'dip_black',
      }),
    });
    const postRes = await handlePostBgm(postReq, 'trans-video-1', mockSupabase);
    const postJson = await postRes.json();
    assert.equal(postJson.success, true);
    assert.equal(postJson.transition, 'dip_black');

    // 3. Subsequent GET confirms persistence
    const getRes2 = await handleGetBgm(getReq, 'trans-video-1', mockSupabase);
    const getJson2 = await getRes2.json();
    assert.equal(getJson2.transition, 'dip_black');
  });
});
