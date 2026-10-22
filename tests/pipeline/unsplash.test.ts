import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadUnsplashAsset, resetUnsplashState, searchUnsplash, toCandidate } from '../../src/pipeline/providers/stock/unsplash.ts';
import { buildDescriptionCredits } from '../../src/pipeline/utils/credits.ts';

const realFetch = globalThis.fetch;
const photo = (id: string) => ({
  id,
  width: 4000,
  height: 2500,
  alt_description: 'container ship in a canal lock',
  urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=abc`, small: `https://images.unsplash.com/photo-${id}?w=400` },
  links: { html: `https://unsplash.com/photos/${id}` },
  user: { name: 'Jane Doe' },
});

describe('Unsplash provider', () => {
  let calls: string[];
  let headers: Array<Record<string, string>>;
  beforeEach(() => {
    resetUnsplashState();
    process.env.UNSPLASH_ACCESS_KEY = 'test-access-key';
    delete process.env.UNSPLASH_HOURLY_BUDGET;
    calls = [];
    headers = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      headers.push((init?.headers ?? {}) as Record<string, string>);
      if (url.includes('/search/photos')) {
        return new Response(JSON.stringify({ results: [photo('a1'), photo('b2')] }), { headers: { 'x-ratelimit-remaining': '40' } });
      }
      if (url.includes('/download')) return new Response('{}');
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.UNSPLASH_ACCESS_KEY;
    delete process.env.UNSPLASH_HOURLY_BUDGET;
    resetUnsplashState();
  });

  it('turns a photo into a credited, landscape-sized candidate', () => {
    const c = toCandidate(photo('a1'), 'ships')!;
    assert.equal(c.provider, 'unsplash');
    assert.equal(c.mediaType, 'image');
    assert.equal(c.attribution, 'Photo by Jane Doe on Unsplash');
    assert.match(c.downloadUrl, /ixid=abc&w=2560&fm=jpg&q=85$/);
    assert.match(c.pageUrl!, /utm_source=yt_automation&utm_medium=referral/);
    assert.equal(toCandidate({ id: 'x' }, 'q'), null, 'incomplete results are skipped');
  });

  it('searches with the Access Key, landscape only, and caches repeats', async () => {
    const first = await searchUnsplash('container ship', { limit: 4 });
    const again = await searchUnsplash('Container Ship ', { limit: 4 });
    assert.equal(first.length, 2);
    assert.deepEqual(again, first);
    assert.equal(calls.length, 1, 'the repeat comes from the cache');
    assert.match(calls[0], /orientation=landscape/);
    assert.equal(headers[0].Authorization, 'Client-ID test-access-key');
  });

  it('does nothing without a key', async () => {
    delete process.env.UNSPLASH_ACCESS_KEY;
    assert.deepEqual(await searchUnsplash('ships'), []);
    assert.equal(calls.length, 0);
  });

  it('stays inside its hourly budget', async () => {
    process.env.UNSPLASH_HOURLY_BUDGET = '2';
    await searchUnsplash('one');
    await searchUnsplash('two');
    assert.deepEqual(await searchUnsplash('three'), [], 'over budget: skipped, no request');
    assert.equal(calls.length, 2);
  });

  it('pauses for the hour when Unsplash says the limit is used up', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('Rate Limit Exceeded', { status: 403 });
    }) as typeof fetch;
    assert.deepEqual(await searchUnsplash('one'), []);
    assert.deepEqual(await searchUnsplash('two'), []);
    assert.equal(calls.length, 1, 'no more requests after the limit');
  });

  it('downloads the photo and reports the download to Unsplash', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unsplash-'));
    try {
      const target = path.join(dir, 'p.jpg');
      await downloadUnsplashAsset(toCandidate(photo('a1'), 'q')!, target);
      assert.ok((await fs.stat(target)).size > 0);
      assert.ok(calls.some((u) => u === 'https://api.unsplash.com/photos/a1/download'), calls.join('\n'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Description credits', () => {
  it('credits Unsplash photographers, alongside Creative Commons sources in the same beat', () => {
    const credits = buildDescriptionCredits([], [
      { license_type: 'royalty_free', attribution_text: 'Photo by Jane Doe on Unsplash · Pixabay Contributor' },
      { license_type: 'cc_by', attribution_text: 'John Smith / Wikimedia Commons · Photo by Ali Khan on Unsplash' },
    ]);
    assert.match(credits, /• Photo by Jane Doe on Unsplash \(Unsplash License\)/);
    assert.match(credits, /• Photo by Ali Khan on Unsplash \(Unsplash License\)/);
    assert.match(credits, /• John Smith \/ Wikimedia Commons \(CC BY\)/);
    assert.doesNotMatch(credits, /Pixabay Contributor/, 'royalty-free stock needs no credit');
  });
});
