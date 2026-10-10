import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { enrichAiPrompt, generateAiVisualCandidate, downloadAndSaveAiImage } from '../../src/pipeline/visuals/ai-image-step';
import { aggregateMediaCandidates } from '../../src/pipeline/visuals/media-aggregator';

test('AI Image Generative Visual Fallback Tests', async (t) => {
  const tempDir = path.join(process.cwd(), 'storage', 'test_ai_image');
  await fs.mkdir(tempDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('1. enrichAiPrompt enhances simple prompts with cinematic documentary tags', () => {
    const raw = 'cyberpunk neuron network';
    const enriched = enrichAiPrompt(raw);

    assert.ok(enriched.includes('cyberpunk neuron network'));
    assert.ok(enriched.includes('cinematic documentary photograph'));
    assert.ok(enriched.includes('16:9 aspect ratio'));

    // Long detailed prompts should remain untouched
    const detailed = 'A photorealistic close up of a vintage typewriter on a dark mahogany desk, cinematic lighting, 8k resolution, highly detailed photo';
    const preserved = enrichAiPrompt(detailed);
    assert.equal(preserved, detailed);
  });

  await t.test('2. generateAiVisualCandidate produces valid MediaCandidate object', async () => {
    const candidate = await generateAiVisualCandidate({
      prompt: 'quantum computer glowing in dark laboratory',
      width: 1920,
      height: 1080,
    });

    assert.equal(candidate.provider, 'pollinations');
    assert.equal(candidate.mediaType, 'image');
    assert.equal(candidate.license, 'own_work');
    assert.equal(candidate.width, 1920);
    assert.equal(candidate.height, 1080);
    assert.ok(candidate.downloadUrl?.includes('pollinations.ai'));
    assert.ok(candidate.thumbnailUrl?.includes('width=480'));
  });

  await t.test('3. downloadAndSaveAiImage writes valid image file to disk', async () => {
    const originalFetch = globalThis.fetch;
    const testFile = path.join(tempDir, 'test_ai.jpg');

    try {
      // Mock fetch returning a 1000-byte dummy buffer
      const dummyBuffer = Buffer.alloc(1024, 0xff);
      globalThis.fetch = async () => {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'image/jpeg' }),
          arrayBuffer: async () => dummyBuffer.buffer,
        } as any;
      };

      const candidate = await generateAiVisualCandidate({
        prompt: 'futuristic flying vehicle over neon metropolis',
      });

      await downloadAndSaveAiImage(candidate, testFile);

      const stat = await fs.stat(testFile);
      assert.ok(stat.size >= 1000, 'Image file should be non-empty and >= 1000 bytes');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('4. aggregateMediaCandidates triggers AI fallback when zero archive/stock items exist', async () => {
    const originalFetch = globalThis.fetch;

    try {
      // Mock fetch returning zero results for Wikipedia/NASA/Archive
      globalThis.fetch = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ query: { pages: {} }, collection: { items: [] }, response: { docs: [] } }),
        } as any;
      };

      const result = await aggregateMediaCandidates({
        query: 'an imaginary fictional glowing alien creature that does not exist in any archive',
        text: 'The organism communicates through bioluminescent pulses.',
        limit: 3,
      });

      // Should automatically have synthesized an AI candidate
      assert.ok(result.candidates.length > 0, 'Expected at least 1 candidate via AI fallback');
      assert.equal(result.candidates[0].provider, 'pollinations');
      assert.equal(result.candidates[0].mediaType, 'image');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
