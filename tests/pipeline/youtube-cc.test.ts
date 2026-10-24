import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acceptVideo,
  cookieArgs,
  DAILY_SEARCH_LIMIT,
  downloadsBlocked,
  isBotCheck,
  isoSeconds,
  resetDownloadBlock,
  searchYoutubeCc,
  takeSearch,
  ytDlpArgs,
} from '../../src/pipeline/visuals/youtube-cc.ts';

const video = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  snippet: { title, channelTitle: 'Drone Guy', thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hq.jpg` } } },
  status: { license: 'creativeCommon' },
  contentDetails: { duration: 'PT2M30S' },
  ...extra,
});

describe('Creative Commons YouTube footage', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytcc-'));
  });
  beforeEach(() => {
    process.env.YOUTUBE_QUOTA_FILE = path.join(dir, `quota-${Math.random()}.json`);
    resetDownloadBlock();
  });
  after(async () => {
    delete process.env.YOUTUBE_QUOTA_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads YouTube durations', () => {
    assert.equal(isoSeconds('PT4M13S'), 253);
    assert.equal(isoSeconds('PT1H2M'), 3720);
    assert.equal(isoSeconds('P1DT1S'), 86401);
    assert.equal(isoSeconds('nonsense'), 0);
  });

  it('keeps real CC footage and turns away broadcasts, highlights and the wrong licence', () => {
    assert.equal(acceptVideo(video('a', '4K drone footage of the Alps')), true);
    assert.equal(acceptVideo(video('b', 'Liverpool vs Milan | Extended Highlights')), false);
    assert.equal(acceptVideo({ ...video('c', 'Harbour at night'), snippet: { title: 'Harbour at night', channelTitle: 'BBC News' } }), false);
    assert.equal(acceptVideo({ ...video('d', 'Harbour'), status: { license: 'youtube' } }), false, 'standard YouTube licence');
    assert.equal(acceptVideo({ ...video('e', 'Harbour'), contentDetails: { duration: 'PT3H' } }), false, 'too long to be footage');
  });

  it('searches CC videos, confirms each licence, and credits the channel with a link', async () => {
    const calls: string[] = [];
    const fake = (async (url: URL | string) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/search')) {
        assert.match(u, /videoLicense=creativeCommon/);
        return new Response(JSON.stringify({ items: [{ id: { videoId: 'aaa' } }, { id: { videoId: 'bbb' } }] }));
      }
      return new Response(JSON.stringify({ items: [video('aaa', 'Container port timelapse'), video('bbb', 'Port | Full Match Highlights')] }));
    }) as typeof fetch;
    const hits = await searchYoutubeCc('container port', { apiKey: 'KEY', fetcher: fake });
    assert.equal(calls.length, 2, 'one search, one details call');
    assert.deepEqual(hits.map((h) => h.id), ['yt_aaa']);
    assert.equal(hits[0].provider, 'youtube_cc');
    assert.equal(hits[0].license, 'cc_by');
    assert.equal(hits[0].duration, 150);
    assert.match(hits[0].attribution!, /by Drone Guy on YouTube \(CC BY\), https:\/\/www\.youtube\.com\/watch\?v=aaa/);
  });

  it('keeps inside the free daily allowance', async () => {
    for (let i = 0; i < DAILY_SEARCH_LIMIT; i++) assert.equal(await takeSearch('2026-10-23'), true);
    assert.equal(await takeSearch('2026-10-23'), false, 'used up for today');
    assert.equal(await takeSearch('2026-10-24'), true, 'a new day');
  });

  it('downloads with the sign-in set in .env.local, and only the start of the video', () => {
    assert.deepEqual(cookieArgs({ YTDLP_COOKIES_FROM_BROWSER: 'firefox' }), ['--cookies-from-browser', 'firefox']);
    assert.deepEqual(cookieArgs({ YTDLP_COOKIES: 'C:/c.txt', YTDLP_COOKIES_FROM_BROWSER: 'firefox' }), ['--cookies', 'C:/c.txt']);
    assert.deepEqual(cookieArgs({}), []);
    const args = ytDlpArgs('https://www.youtube.com/watch?v=aaa', 'out.mp4', null, { YTDLP_COOKIES_FROM_BROWSER: 'edge' });
    assert.ok(args.includes('--cookies-from-browser') && args.includes('edge'));
    assert.ok(args.includes('*0-240'));
    assert.ok(!args.includes('--ffmpeg-location'), 'ffmpeg from PATH');
  });

  it('recognises a bot check, and pauses YouTube searches while downloads are refused', async () => {
    assert.equal(isBotCheck("ERROR: Sign in to confirm you're not a bot"), true);
    assert.equal(isBotCheck('ERROR: Video unavailable'), false);
    assert.equal(downloadsBlocked(), false);
  });
});
