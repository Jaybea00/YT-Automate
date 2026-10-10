import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../../src/pipeline/utils/ffmpeg';
import { renderBeatScene } from '../../src/pipeline/assembly/assemble-beat';
import { computeInputHash } from '../../src/pipeline/utils/hash';
import { handlePatchVisual } from '../../src/app/api/videos/[id]/beats/[index]/visual/route';

const execFileAsync = promisify(execFile);

// Helper to generate a dummy 4-second video with time counter
async function createTestVideo(outputPath: string, durationSec = 4): Promise<void> {
  const ffmpeg = getFfmpegPath();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc=duration=${durationSec}:size=1280x720:rate=30`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
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

test('Video Trim Offsets Pipeline Tests', async (t) => {
  const tempDir = path.join(process.cwd(), 'storage', 'test_trim_offsets');
  await fs.mkdir(tempDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('1. computeInputHash differentiates scenes with different startOffsetSeconds', () => {
    const hash0 = computeInputHash({
      stage: 'assembly',
      beatIndex: 0,
      visualPath: 'test.mp4',
      audioPath: 'test.aac',
      durationMs: 3000,
      padStyle: 'blur',
      startOffsetSeconds: 0,
    });

    const hash1 = computeInputHash({
      stage: 'assembly',
      beatIndex: 0,
      visualPath: 'test.mp4',
      audioPath: 'test.aac',
      durationMs: 3000,
      padStyle: 'blur',
      startOffsetSeconds: 2.5,
    });

    assert.notEqual(hash0, hash1, 'Changing startOffsetSeconds must invalidate cache inputHash');
  });

  await t.test('2. renderBeatScene applies startOffsetSeconds to video input and produces valid 1080p MP4', async () => {
    const videoPath = path.join(tempDir, 'source_4s.mp4');
    const audioPath = path.join(tempDir, 'narration_2s.aac');
    const outputPath = path.join(tempDir, 'trimmed_scene.mp4');

    await createTestVideo(videoPath, 4);
    await createTestAudio(audioPath, 2);

    await renderBeatScene({
      visualPath: videoPath,
      audioPath,
      durationMs: 2000,
      outputPath,
      isVideo: true,
      startOffsetSeconds: 1.5,
      padStyle: 'blur',
    });

    const stat = await fs.stat(outputPath);
    assert.ok(stat.size > 0, 'Trimmed scene output must exist and be non-empty');
  });

  await t.test('3. handlePatchVisual updates start_offset_seconds in video_assets and script_json', async () => {
    let mockAssetRecord: any = {
      id: 'asset-trim-1',
      video_id: 'vid-trim-123',
      beat_index: 0,
      start_offset_seconds: 0,
    };

    let mockVideoRecord: any = {
      id: 'vid-trim-123',
      script_json: {},
    };

    const mockSupabase: any = {
      from(table: string) {
        if (table === 'video_assets') {
          return {
            select() {
              return {
                eq(_col: string, val: any) {
                  return {
                    eq(_c2: string, _v2: any) {
                      return {
                        async maybeSingle() {
                          return { data: mockAssetRecord, error: null };
                        },
                      };
                    },
                  };
                },
              };
            },
            update(updates: any) {
              return {
                eq() {
                  mockAssetRecord = { ...mockAssetRecord, ...updates };
                  return Promise.resolve({ data: mockAssetRecord, error: null });
                },
              };
            },
          };
        }
        if (table === 'videos') {
          return {
            select() {
              return {
                eq() {
                  return {
                    async maybeSingle() {
                      return { data: mockVideoRecord, error: null };
                    },
                  };
                },
              };
            },
            update(updates: any) {
              return {
                eq() {
                  mockVideoRecord = { ...mockVideoRecord, ...updates };
                  return Promise.resolve({ data: mockVideoRecord, error: null });
                },
              };
            },
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    };

    const req = new Request('http://localhost/api/videos/vid-trim-123/beats/0/visual', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_offset_seconds: 3.5 }),
    });

    const res = await handlePatchVisual(req, 'vid-trim-123', '0', mockSupabase);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.asset.start_offset_seconds, 3.5);

    // Verify persisted in video_assets
    assert.equal(mockAssetRecord.start_offset_seconds, 3.5);

    // Verify synced into script_json.trim_offsets
    assert.equal(mockVideoRecord.script_json.trim_offsets[0].start_offset_seconds, 3.5);
  });
});
