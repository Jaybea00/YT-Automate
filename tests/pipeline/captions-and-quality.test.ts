import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  generateAssCaptions,
  formatAssTime,
  writeAssCaptionsFile,
} from '../../src/pipeline/assembly/captions';
import {
  checkSlideshowRisk,
  verifyAudioIntegrity,
} from '../../src/pipeline/assembly/quality-guard';
import { getFfmpegPath } from '../../src/pipeline/utils/ffmpeg';

const execFileAsync = promisify(execFile);

// Helper to generate a dummy 440Hz audible test tone
async function createTestAudioVideo(outputPath: string, durationSec = 2): Promise<void> {
  const ffmpeg = getFfmpegPath();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=blue:s=640x360:r=30',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(durationSec),
    '-c:v', 'libx264',
    '-c:a', 'aac',
    outputPath,
  ]);
}

test('Kinetic Captions & Quality Governance Tests', async (t) => {
  const tempDir = path.join(process.cwd(), 'storage', 'test_captions_quality');
  await fs.mkdir(tempDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('1. formatAssTime correctly formats centiseconds', () => {
    assert.equal(formatAssTime(0), '0:00:00.00');
    assert.equal(formatAssTime(1540), '0:00:01.54');
    assert.equal(formatAssTime(65230), '0:01:05.23');
  });

  await t.test('2. generateAssCaptions builds ASS file with active word highlight tags', () => {
    const { assContent, dialogues } = generateAssCaptions({
      beats: [
        { index: 0, text: 'The revolutionary engine started instantly' },
        { index: 1, text: 'Powering rockets beyond the solar system' },
      ],
      units: [
        { unit_index: 0, duration_ms: 2000 },
        { unit_index: 1, duration_ms: 2500 },
      ],
      preset: 'vox',
    });

    assert.ok(assContent.includes('[Script Info]'));
    assert.ok(assContent.includes('Style: VoxMinimal'));
    assert.ok(assContent.includes('{\\c&H00D4FF&}')); // Active word highlight
    assert.ok(dialogues.length >= 4);
    assert.equal(dialogues[0].style, 'VoxMinimal');
  });

  await t.test('3. checkSlideshowRisk evaluates motion density and detects static sequences', () => {
    // Sequence with Ken Burns zooming
    const safeResult = checkSlideshowRisk([
      { isVideo: false, stillMotion: 'zoom' },
      { isVideo: false, stillMotion: 'zoom' },
      { isVideo: true },
    ]);
    assert.equal(safeResult.isSafe, true);
    assert.equal(safeResult.score, 0);

    // Sequence with too many static still frames
    const riskyResult = checkSlideshowRisk([
      { isVideo: false, stillMotion: 'static' },
      { isVideo: false, stillMotion: 'static' },
      { isVideo: false, stillMotion: 'static' },
    ]);
    assert.equal(riskyResult.isSafe, false);
    assert.ok(riskyResult.score >= 0.5);
    assert.ok(riskyResult.recommendations.length > 0);
  });

  await t.test('4. verifyAudioIntegrity inspects audio level and checks clipping', async () => {
    const videoFile = path.join(tempDir, 'test_media.mp4');
    await createTestAudioVideo(videoFile, 1.5);

    const check = await verifyAudioIntegrity(videoFile);
    assert.equal(check.isClean, true);
    assert.equal(check.hasClipping, false);
    assert.ok(check.maxVolumeDb <= 0.05);
  });
});
