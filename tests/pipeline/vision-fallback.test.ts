import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pickFootage, resetVisionHealth, visionRank, withVisionRetries } from '../../src/pipeline/visuals/footage-picker.ts';
import { createShotRenderer } from '../../src/pipeline/visuals/shot-renderers.ts';
import { MOTION_RENDERERS } from '../../src/pipeline/visuals/motion-shots.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import type { ShotPlan } from '../../src/lib/script/generate-script.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';

const realFetch = globalThis.fetch;

/** Every search finds one Wikimedia photo titled "Golden Boy Coaches bus"; every thumbnail loads. */
function mockNetwork(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (/thumb|\.jpg/.test(url)) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } });
    if (url.includes('commons.wikimedia.org')) {
      return new Response(
        JSON.stringify({ query: { pages: { 1: { pageid: 1, title: 'File:Golden Boy Coaches bus.jpg', imageinfo: [{ url: 'https://img.test/bus.jpg', thumburl: 'https://img.test/thumb/bus.jpg', mime: 'image/jpeg', width: 2000, height: 1200 }] } } } }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const shot = (extra: Partial<ShotPlan> = {}): ShotPlan => ({
  visual_type: 'archive',
  visual_query: 'Golden Boy award trophy presentation 2010',
  covers: 'That December, he won the Golden Boy award.',
  word_start: 0,
  word_count: 8,
  ...extra,
});

/** A vision model that fails its first `failures` calls, then rates everything 8. */
function flakyVision(failures: number, calls = { n: 0 }): LLMProvider {
  return {
    kind: 'llm',
    id: 'flaky-vision',
    supportsVision: true,
    generateText: async () => ({ text: '', usage: {} }),
    generateJson: async () => {
      calls.n++;
      if (calls.n <= failures) throw new Error('429 RESOURCE_EXHAUSTED: quota exceeded');
      return { data: { ratings: [{ index: 1, score: 8, era_ok: true, subject_match: true, reason: 'ok' }] } as never, usage: {} };
    },
  };
}

describe('Relevance check outages', () => {
  beforeEach(() => {
    resetVisionHealth();
    mockNetwork();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetVisionHealth();
  });

  it('never falls back to title matching when the check fails: nothing is picked, and it says why', async () => {
    const calls = { n: 0 };
    const picked = await pickFootage({ shot: shot(), llmProvider: flakyVision(99, calls), llmCtx: { apiKey: 'k' }, retryDelaysMs: [0, 0] });
    assert.deepEqual(picked.ranked, [], 'the "Golden Boy Coaches" bus is not used');
    assert.equal(picked.checked, false);
    assert.match(picked.unavailable ?? '', /quota exceeded/);
    assert.equal(calls.n, 3, 'tried once, then retried twice');
  });

  it('a brief failure that clears on retry still gets a checked pick', async () => {
    const picked = await pickFootage({ shot: shot(), llmProvider: flakyVision(1), llmCtx: { apiKey: 'k' }, retryDelaysMs: [0, 0] });
    assert.equal(picked.checked, true);
    assert.equal(picked.ranked.length, 1);
    assert.equal(picked.unavailable, undefined);
  });

  it('after repeated failures, stops waiting on retries for a while', async () => {
    const failing = async () => {
      throw new Error('503 overloaded');
    };
    await assert.rejects(withVisionRetries(failing, []));
    await assert.rejects(withVisionRetries(failing, []));
    let called = false;
    await assert.rejects(
      withVisionRetries(async () => {
        called = true;
        return 1;
      }, []),
      /paused/,
    );
    assert.equal(called, false, 'the check is not even attempted while paused');
  });

  it('still ranks by title when no vision model is configured at all', async () => {
    const picked = await pickFootage({ shot: shot() });
    assert.equal(picked.checked, false);
    assert.equal(picked.unavailable, undefined);
    assert.equal(picked.ranked.length, 1);
  });

  it('renders a "needs check" text card instead of unrelated footage', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'needs-check-'));
    try {
      // Two outages in a row pause the checks, so the render below doesn't wait on retries
      const failing = async () => {
        throw new Error('429 quota');
      };
      await assert.rejects(withVisionRetries(failing, []));
      await assert.rejects(withVisionRetries(failing, []));

      const render = createShotRenderer(
        { beatIndex: 0, downloadDir: dir, theme: themeForStyle('sport'), llmProvider: flakyVision(99), llmCtx: { apiKey: 'k' }, usedSources: new Set(), motionCounter: { next: 0 } },
        MOTION_RENDERERS,
      );
      const result = await render({ shot: shot(), startSec: 0, frames: 10 }, path.join(dir, 'shot.mp4'));
      assert.equal(result.renderedType, 'kinetic_text');
      assert.equal(result.fallback, true);
      assert.equal(result.needsCheck, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('tells the check to reject a different club or brand than the story is about', async () => {
    const prompts: string[] = [];
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock',
      supportsVision: true,
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async (req) => {
        prompts.push(req.prompt);
        return { data: { ratings: [] } as never, usage: {} };
      },
    };
    await visionRank(shot({ visual_type: 'stock', visual_query: 'Manchester City trophy celebration' }), [
      { id: 'x', provider: 'wikimedia', mediaType: 'image', title: 'x', thumbnailUrl: 'https://img.test/thumb/x.jpg', downloadUrl: 'https://img.test/x.jpg' },
    ], llm, { apiKey: 'k' });
    assert.match(prompts[0], /different from the one the shot or narration is about, score it at most 3/);
  });
});
