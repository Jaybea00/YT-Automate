import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  broadQueryFor,
  heuristicRank,
  pickFootage,
  queryVariants,
  stockQueryFor,
  visionRank,
} from '../../src/pipeline/visuals/footage-picker.ts';
import { documentZoomTemplate, findNewspaperScan, largerWikimediaImage, scanQueries } from '../../src/pipeline/visuals/newspaper-scan.ts';
import { pickVideoSegment, sampleTimes } from '../../src/pipeline/visuals/segment-picker.ts';
import { createShotRenderer } from '../../src/pipeline/visuals/shot-renderers.ts';
import { MOTION_RENDERERS } from '../../src/pipeline/visuals/motion-shots.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import type { ShotPlan } from '../../src/lib/script/generate-script.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import type { MediaCandidate } from '../../src/pipeline/visuals/types.ts';

const execFileAsync = promisify(execFile);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every request returns a tiny JPEG (thumbnails) or an empty JSON result (searches). */
function mockNetwork(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (/thumb|\.jpg/.test(url)) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return urls;
}

const shot = (extra: Partial<ShotPlan>): ShotPlan => ({
  visual_type: 'archive',
  visual_query: 'q',
  covers: 'words heard here',
  word_start: 0,
  word_count: 3,
  ...extra,
});

const candidate = (id: string, extra: Partial<MediaCandidate> = {}): MediaCandidate => ({
  id,
  provider: 'wikimedia',
  mediaType: 'image',
  title: id,
  thumbnailUrl: `https://img.test/thumb/${id}.jpg`,
  downloadUrl: `https://img.test/${id}.jpg`,
  pageUrl: `https://img.test/page/${id}`,
  ...extra,
});

function mockVision(ratings: Array<Record<string, unknown>>, prompts: string[] = []): LLMProvider {
  return {
    kind: 'llm',
    id: 'mock-vision',
    supportsVision: true,
    generateText: async () => ({ text: '', usage: {} }),
    generateJson: async (req) => {
      prompts.push(req.prompt);
      return { data: { ratings } as never, usage: {} };
    },
  };
}

describe('Footage search phrasing', () => {
  it('builds specific-to-broad phrasings, including surname and year', () => {
    const variants = queryVariants('Franklin D. Roosevelt speech 1933 newsreel');
    assert.equal(variants[0], 'Franklin D. Roosevelt speech 1933 newsreel');
    assert.ok(variants.includes('Roosevelt 1933'), variants.join(' | '));
    assert.ok(variants.includes('Franklin D. Roosevelt'));
  });

  it('drops style words and never searches a year alone', () => {
    const variants = queryVariants('vintage financial ledger handwritten columns numbers 1920s office');
    assert.ok(variants.every((v) => !/^\d{4}s?$/.test(v)), variants.join(' | '));
    assert.ok(!variants[0].includes('vintage'));
    assert.equal(stockQueryFor('1929 frantic traders shouting floor'), 'traders floor');
    assert.equal(broadQueryFor('Franklin D. Roosevelt speech 1933 newsreel', true), 'Roosevelt 1933');
    assert.equal(broadQueryFor('vintage financial ledger handwritten 1920s', false), 'financial ledger');
  });

  it('ranks by shared words when vision is unavailable', () => {
    const ranked = heuristicRank(shot({ visual_query: 'bank crowd 1931' }), [
      candidate('concert', { title: 'rock concert crowd', provider: 'pixabay' }),
      candidate('bank', { title: 'Crowd outside closed bank 1931' }),
    ]);
    assert.equal(ranked[0].candidate.id, 'bank');
  });
});

describe('Vision relevance check', () => {
  it('caps candidates that miss the named subject or the era, and prefers motion', async () => {
    mockNetwork();
    const prompts: string[] = [];
    const llm = mockVision(
      [
        { index: 1, score: 9, era_ok: true, subject_match: false, reason: 'right era, wrong person' },
        { index: 2, score: 8, era_ok: false, subject_match: true, reason: 'modern photo' },
        { index: 3, score: 7, era_ok: true, subject_match: true, reason: 'the film itself' },
      ],
      prompts,
    );
    const ranked = await visionRank(
      shot({ visual_query: 'Franklin D. Roosevelt speech 1933' }),
      [candidate('a'), candidate('b'), candidate('c', { mediaType: 'video', title: 'Roosevelt Inaugurated 1933' })],
      llm,
      { apiKey: 'k' },
    );
    assert.deepEqual(ranked.map((r) => [r.candidate.id, Math.round(r.score * 10) / 10]), [['c', 7.3], ['a', 5], ['b', 5]]);
    assert.match(prompts[0], /a film titled "Roosevelt Inaugurated 1933"/, 'titles are shown with thumbnails');
    assert.match(prompts[0], /set in 1933/);
  });

  it('applies the period to b-roll when the query names a year', async () => {
    mockNetwork();
    const llm = mockVision([{ index: 1, score: 8, era_ok: false, subject_match: true, reason: '2002 spreadsheet' }]);
    const [r] = await visionRank(shot({ visual_type: 'stock', visual_query: 'ledger 1920s office' }), [candidate('x')], llm, { apiKey: 'k' });
    assert.equal(r.score, 5);
  });

  it('shows the narration as type when nothing relevant is found, never an unrelated clip', async () => {
    mockNetwork();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picker-'));
    try {
      const llm = mockVision([]);
      const picked = await pickFootage({ shot: shot({ visual_query: 'nothing matches this' }), llmProvider: llm, llmCtx: { apiKey: 'k' } });
      assert.deepEqual(picked.ranked, []);

      const render = createShotRenderer(
        { beatIndex: 0, downloadDir: dir, theme: themeForStyle('story_driven'), llmProvider: llm, llmCtx: { apiKey: 'k' }, usedSources: new Set(), motionCounter: { next: 0 } },
        MOTION_RENDERERS,
      );
      const result = await render({ shot: shot({ covers: 'Thousands of banks failed' }), startSec: 0, frames: 10 }, path.join(dir, 'card.mp4'));
      assert.equal(result.renderedType, 'kinetic_text');
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', result.clipPath]);
      assert.equal(Number(stdout.trim().replace(/,$/, '')), 10);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Newspaper scans', () => {
  const paper = { outlet: 'Variety', date: 'October 30, 1929', headline: 'Wall St. Lays an Egg' };

  it('searches several phrasings and asks for large renditions', () => {
    const qs = scanQueries(paper);
    assert.ok(qs.includes('Variety 1929 front page'));
    assert.ok(qs.includes('Variety Wall St. Lays an Egg'));
    const c = candidate('p', {
      width: 4000,
      thumbnailUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/P.jpg/800px-P.jpg',
      downloadUrl: 'https://upload.wikimedia.org/wikipedia/commons/3/3d/P.jpg',
    });
    assert.match(largerWikimediaImage(c), /\/2400px-P\.jpg$/);
    assert.equal(largerWikimediaImage({ ...c, width: 639 }), c.downloadUrl, 'small originals are used as they are');
  });

  it('never uses an unverified scan', async () => {
    assert.equal(await findNewspaperScan(paper, undefined, undefined), null);
  });

  it('escapes the caption in the document zoom', () => {
    const html = documentZoomTemplate(themeForStyle('vox_explainer'), { imageUrl: 'data:image/jpeg;base64,', width: 600, height: 900 }, [100, 50, 160, 950], { ...paper, outlet: '<b>Variety</b>' }, 'Wikimedia Commons');
    assert.ok(!html.includes('<b>Variety'));
    assert.match(html, /Archive scan · Wikimedia Commons/);
    assert.match(html, /window\.__frame/);
  });
});

describe('Choosing the segment of a long film', () => {
  it('samples across the film, leaving room for the whole shot', () => {
    const times = sampleTimes(300, 4);
    assert.equal(times.length, 6);
    assert.ok(times.every((t) => t >= 0 && t <= 300 - 4));
    assert.ok(times[0] < 30 && times[5] > 250);
  });

  it('keeps the default start for short clips or without vision', async () => {
    const s = shot({});
    assert.equal(await pickVideoSegment({ sourcePath: 'x.mp4', sourceSec: 10, shotSec: 4, shot: s, llm: mockVision([]), llmCtx: { apiKey: 'k' } }), null);
    assert.equal(await pickVideoSegment({ sourcePath: 'x.mp4', sourceSec: 300, shotSec: 4, shot: s }), null);
  });
});
