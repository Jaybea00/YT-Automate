import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath, getVideoDurationMs } from '../../src/pipeline/utils/ffmpeg';
import { renderBeatScene } from '../../src/pipeline/assembly/assemble-beat';

const execFileAsync = promisify(execFile);

// Helper to create a test still image (1920x1080 or custom size)
async function createTestImage(outputPath: string, width = 1920, height = 1080): Promise<void> {
  const ffmpeg = getFfmpegPath();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=blue:s=${width}x${height}`,
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

test('Ken Burns Dynamic Motion Pipeline Tests', async (t) => {
  const tempDir = path.join(process.cwd(), 'storage', 'test_ken_burns');
  await fs.mkdir(tempDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('1. renders still image with Ken Burns zoom motion and black letterbox', async () => {
    const imgPath = path.join(tempDir, 'test_16x9.png');
    const audioPath = path.join(tempDir, 'audio_2s.aac');
    const outPath = path.join(tempDir, 'out_kb_black.mp4');

    await createTestImage(imgPath, 1920, 1080);
    await createTestAudio(audioPath, 2.0);

    await renderBeatScene({
      visualPath: imgPath,
      audioPath,
      durationMs: 2000,
      outputPath: outPath,
      isVideo: false,
      stillMotion: 'zoom',
      padStyle: 'black',
    });

    const stat = await fs.stat(outPath);
    assert.ok(stat.size > 0, 'Ken burns video output must exist and be non-empty');

    const durationMs = await getVideoDurationMs(outPath);
    assert.ok(
      Math.abs(durationMs - 2000) <= 200,
      `Video duration (${durationMs}ms) must match audio duration (2000ms)`,
    );
  });

  await t.test('2. renders non-16:9 still image with Ken Burns zoom motion and blurred background', async () => {
    const imgPath = path.join(tempDir, 'test_square.png');
    const audioPath = path.join(tempDir, 'audio_2s_square.aac');
    const outPath = path.join(tempDir, 'out_kb_blur.mp4');

    // Square image (1080x1080)
    await createTestImage(imgPath, 1080, 1080);
    await createTestAudio(audioPath, 2.0);

    await renderBeatScene({
      visualPath: imgPath,
      audioPath,
      durationMs: 2000,
      outputPath: outPath,
      isVideo: false,
      stillMotion: 'zoom',
      padStyle: 'blur',
    });

    const stat = await fs.stat(outPath);
    assert.ok(stat.size > 0, 'Ken burns blurred padding video must exist and be non-empty');

    const durationMs = await getVideoDurationMs(outPath);
    assert.ok(
      Math.abs(durationMs - 2000) <= 200,
      `Video duration (${durationMs}ms) must match audio duration (2000ms)`,
    );
  });
});
