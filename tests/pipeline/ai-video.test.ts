import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { generateAiMotionVideoCandidate, downloadAndSaveAiVideo } from '../../src/pipeline/visuals/ai-video-step';
import { falVideo } from '../../src/pipeline/providers/video/fal';

test('AI Motion Video Generation (Google Veo / Kling) Tests', async (t) => {
  const tempDir = path.join(process.cwd(), 'storage', 'test_ai_video');
  await fs.mkdir(tempDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('1. throws friendly ConfigurationError when all video keys are missing', async () => {
    const origFal = process.env.FAL_KEY;
    const origGVeo = process.env.GOOGLE_VEO_API_KEY;
    const origGemini = process.env.GEMINI_API_KEY;
    const origGApi = process.env.GOOGLE_API_KEY;
    delete process.env.FAL_KEY;
    delete process.env.GOOGLE_VEO_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    try {
      await assert.rejects(
        async () => {
          await generateAiMotionVideoCandidate({
            prompt: 'drone camera fly-through of ancient roman colosseum',
            model: 'veo2',
          });
        },
        (err: any) => {
          assert.ok(err.message.includes('GOOGLE_VEO_API_KEY') || err.message.includes('FAL_KEY'));
          assert.ok(err.message.includes('Google Veo'));
          return true;
        },
      );
    } finally {
      if (origFal) process.env.FAL_KEY = origFal;
      if (origGVeo) process.env.GOOGLE_VEO_API_KEY = origGVeo;
      if (origGemini) process.env.GEMINI_API_KEY = origGemini;
      if (origGApi) process.env.GOOGLE_API_KEY = origGApi;
    }
  });

  await t.test('2. generateAiMotionVideoCandidate generates valid video candidate with direct Google Veo key', async () => {
    const origGVeo = process.env.GOOGLE_VEO_API_KEY;
    const origFal = process.env.FAL_KEY;
    const originalFetch = globalThis.fetch;
    delete process.env.FAL_KEY;
    process.env.GOOGLE_VEO_API_KEY = 'test_google_veo_direct_key';

    try {
      // Mock Google Generative Language long-running operation submit & poll
      globalThis.fetch = async (url: any, opts: any) => {
        const urlStr = String(url);
        if (urlStr.includes('predictLongRunning')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ name: 'operations/op_veo_456' }),
          } as any;
        }
        if (urlStr.includes('operations/op_veo_456')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              done: true,
              response: {
                generateVideoResponse: {
                  generatedSamples: [
                    {
                      video: {
                        uri: 'https://generativelanguage.googleapis.com/download/veo_sample_789.mp4',
                      },
                    },
                  ],
                },
              },
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      };

      const candidate = await generateAiMotionVideoCandidate({
        prompt: 'macro shot of dew drop falling on vibrant green leaf in slow motion',
        model: 'veo2',
        durationSeconds: 5,
      });

      assert.equal(candidate.provider, 'google_veo');
      assert.equal(candidate.mediaType, 'video');
      assert.equal(candidate.license, 'own_work');
      assert.equal(candidate.downloadUrl, 'https://generativelanguage.googleapis.com/download/veo_sample_789.mp4');
      assert.ok(candidate.attribution?.includes('Google Veo 2'));
    } finally {
      process.env.GOOGLE_VEO_API_KEY = origGVeo;
      process.env.FAL_KEY = origFal;
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('3. generateAiMotionVideoCandidate generates valid video candidate when FAL_KEY is provided', async () => {
    const originalKey = process.env.FAL_KEY;
    const origGVeo = process.env.GOOGLE_VEO_API_KEY;
    const originalFetch = globalThis.fetch;
    delete process.env.GOOGLE_VEO_API_KEY;
    process.env.FAL_KEY = 'test_dummy_fal_key';

    try {
      // Mock Fal queue submit and poll endpoints
      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/status')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'COMPLETED' }),
          } as any;
        }
        if (urlStr.includes('/requests/req_123')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              video: {
                url: 'https://fal.media/files/mock_veo_output.mp4',
                content_type: 'video/mp4',
              },
            }),
          } as any;
        }
        // Initial submit
        return {
          ok: true,
          status: 200,
          json: async () => ({ request_id: 'req_123' }),
        } as any;
      };

      const candidate = await generateAiMotionVideoCandidate({
        prompt: 'cinematic drone sweep over glowing neon city',
        model: 'veo2',
        durationSeconds: 5,
      });

      assert.equal(candidate.provider, 'fal');
      assert.equal(candidate.mediaType, 'video');
      assert.equal(candidate.license, 'own_work');
      assert.equal(candidate.downloadUrl, 'https://fal.media/files/mock_veo_output.mp4');
      assert.ok(candidate.attribution?.includes('VEO2'));
    } finally {
      process.env.FAL_KEY = originalKey;
      process.env.GOOGLE_VEO_API_KEY = origGVeo;
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('4. downloadAndSaveAiVideo downloads MP4 file to target destination', async () => {
    const originalFetch = globalThis.fetch;
    const destFile = path.join(tempDir, 'output_motion.mp4');

    try {
      const dummyMp4Buffer = Buffer.alloc(2048, 0x00);
      globalThis.fetch = async () => {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => dummyMp4Buffer.buffer,
        } as any;
      };

      await downloadAndSaveAiVideo('https://fal.media/files/test.mp4', destFile);

      const stat = await fs.stat(destFile);
      assert.ok(stat.size >= 1000, 'Expected non-empty video file on disk');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

