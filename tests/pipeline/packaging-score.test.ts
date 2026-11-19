import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bestPairs,
  buildScorePrompt,
  MAX_COMPETITORS,
  nicheQueries,
  nicheVideos,
  normalizePairs,
  pickCompetitors,
  scoreIsCurrent,
  type PackagingScore,
} from '../../src/pipeline/publish/packaging-score.ts';

const video = (id: string, views: number, duration: string) => ({
  id,
  snippet: { title: `Video ${id}`, channelTitle: `Channel ${id}`, thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } } },
  statistics: { viewCount: String(views) },
  contentDetails: { duration },
});

describe('title and thumbnail scoring', () => {
  it('compares with long videos only, most-watched first', () => {
    const picked = pickCompetitors([video('a', 500, 'PT10M'), video('short', 9e6, 'PT45S'), video('b', 2e6, 'PT1H2M'), video('c', 30_000, 'PT3M')]);
    assert.deepEqual(picked.map((v) => v.id), ['b', 'c', 'a']);
    assert.equal(picked[0].thumbUrl, 'https://i.ytimg.com/vi/b/mqdefault.jpg');
    assert.ok(pickCompetitors(Array.from({ length: 20 }, (_, i) => video(String(i), i, 'PT8M'))).length <= MAX_COMPETITORS);
  });

  it('searches YouTube once and reads the details, or returns nothing without a key', async () => {
    process.env.YOUTUBE_QUOTA_FILE = path.join(os.tmpdir(), `yt-quota-${Date.now()}.json`);
    const calls: string[] = [];
    const fetcher = (async (url: URL | string) => {
      calls.push(new URL(String(url)).pathname);
      const body = String(url).includes('/search') ? { items: [{ id: { videoId: 'a' } }, { id: { videoId: 'b' } }] } : { items: [video('a', 10, 'PT9M'), video('b', 99, 'PT9M')] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const found = await nicheVideos('why we feel empty after success', { apiKey: 'k', fetcher });
    assert.deepEqual(found.map((v) => v.id), ['b', 'a']);
    assert.deepEqual(calls, ['/youtube/v3/search', '/youtube/v3/videos']);
    calls.length = 0;
    await nicheVideos(['a', 'b'], { apiKey: 'k', fetcher });
    assert.deepEqual(calls, ['/youtube/v3/search', '/youtube/v3/search', '/youtube/v3/videos']);
    assert.deepEqual(await nicheVideos('x', { apiKey: '', fetcher }), []);
  });

  it('searches for the topic without framing, then the title when it differs', () => {
    assert.deepEqual(nicheQueries('POV: You Quietly Realized You Won the Wrong Game', 'You Won the Wrong Game'), ['You Quietly Realized You Won the Wrong Game', 'You Won the Wrong Game']);
    assert.deepEqual(nicheQueries('Arrival fallacy', 'arrival fallacy'), ['Arrival fallacy']);
    assert.deepEqual(nicheQueries('', 'Why Success Feels Empty'), ['Why Success Feels Empty']);
  });

  it('numbers the feed, then our thumbnails after it', () => {
    const p = buildScorePrompt({
      topic: 'arrival fallacy',
      summary: 'Why winning can feel empty.',
      titles: ['You Won the Wrong Game', 'Why Success Feels Empty'],
      thumbnailTexts: ['EMPTY?', 'IS THAT IT?'],
      competitors: [{ id: 'a', title: 'The Arrival Fallacy', channel: 'Psych', views: 1_200_000, thumbUrl: '' }],
    });
    assert.match(p, /Images 1-1 are the thumbnails/);
    assert.match(p, /1\. "The Arrival Fallacy" \(Psych, 1\.2M views\)/);
    assert.match(p, /Thumbnail 2 = image 3 \(its text: "IS THAT IT\?"\)/);
    assert.match(p, /Score every pair .*4 pairs/);
    assert.match(buildScorePrompt({ topic: 't', summary: 's', titles: ['a'], thumbnailTexts: ['x'], competitors: [] }), /No feed of competing videos/);
  });

  it('keeps one score per real pair, 1-10, best first', () => {
    const pairs = normalizePairs(
      [
        { title: 1, thumbnail: 2, score: 7.4, reason: 'Good contrast.' },
        { title: 2, thumbnail: 1, score: 9, reason: ' Clear question. ' },
        { title: 1, thumbnail: 2, score: 3, reason: 'duplicate' },
        { title: 5, thumbnail: 1, score: 8, reason: 'no such title' },
        { title: 1, thumbnail: 9, score: 8, reason: 'no such thumbnail' },
        { title: 2, thumbnail: 2, score: 14, reason: 'Over the top.' },
      ],
      2,
      3,
    );
    assert.deepEqual(pairs.map((p) => [p.title, p.thumbnail, p.score, p.reason]), [
      [1, 2, 10, 'Over the top.'],
      [1, 1, 9, 'Clear question.'],
      [0, 2, 7.4, 'Good contrast.'],
    ]);
  });

  it('tests different thumbnails first, then fills with the next best pairs', () => {
    const p = (title: number, thumbnail: number, score: number) => ({ title, thumbnail, score, reason: '' });
    const ranked = [p(0, 1, 9), p(1, 1, 8.5), p(1, 2, 8), p(0, 3, 6), p(2, 2, 5)];
    assert.deepEqual(bestPairs(ranked), [
      { title: 0, thumbnail: 1 },
      { title: 1, thumbnail: 2 },
      { title: 0, thumbnail: 3 },
    ]);
    assert.deepEqual(bestPairs([p(0, 1, 9), p(1, 1, 8)]), [
      { title: 0, thumbnail: 1 },
      { title: 1, thumbnail: 1 },
    ]);
  });

  it('goes stale when the titles or thumbnails change', () => {
    const score = { titles: ['A', 'B'], thumbnailTexts: ['x', 'y'] } as PackagingScore;
    assert.equal(scoreIsCurrent(score, ['A', 'B', 'A'], ['x', 'y']), true);
    assert.equal(scoreIsCurrent(score, ['A', 'C'], ['x', 'y']), false);
    assert.equal(scoreIsCurrent(score, ['A', 'B'], ['x', 'z']), false);
  });
});
