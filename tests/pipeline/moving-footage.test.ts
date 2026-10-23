import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pickFilmFrame } from '../../src/pipeline/providers/stock/archive-org.ts';
import { MIN_RELEVANCE, MOTION_BONUS, SPACE_SUBJECT, gatherCandidates, visionRank, withFilmFrames } from '../../src/pipeline/visuals/footage-picker.ts';
import type { MediaCandidate } from '../../src/pipeline/visuals/types.ts';
import type { ShotPlan } from '../../src/lib/script/generate-script.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const film = (id: string, extra: Partial<MediaCandidate> = {}): MediaCandidate => ({
  id: `archive_${id}`,
  provider: 'archive_org',
  mediaType: 'video',
  title: id,
  thumbnailUrl: `https://archive.org/services/img/${id}`,
  downloadUrl: `https://archive.org/download/${id}`,
  pageUrl: `https://archive.org/details/${id}`,
  ...extra,
});

const shot = (over: Partial<ShotPlan> = {}): ShotPlan =>
  ({ visual_type: 'archive', visual_query: 'Sarajevo 1914 motorcade', covers: 'The motorcade turns', ...over }) as ShotPlan;

describe('More real moving footage', () => {
  it('picks a frame about 40% into an archive.org film', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ name: `Newsreel.thumbs/Newsreel_${String(i).padStart(6, '0')}.jpg` }));
    assert.equal(pickFilmFrame('news1914', [{ name: 'Newsreel.mp4' }, ...files]), 'https://archive.org/download/news1914/Newsreel.thumbs/Newsreel_000004.jpg');
    assert.equal(pickFilmFrame('x', [{ name: 'a.mp4' }]), null);
  });

  it('judges films on an inside frame and drops films that cannot be downloaded', async () => {
    const out = await withFilmFrames(
      [film('good'), film('nothumbs'), film('toobig'), { ...film('photo'), mediaType: 'image' }],
      async (id) => (id === 'good' ? { frameUrl: 'https://archive.org/download/good/g.thumbs/g_000004.jpg' } : id === 'toobig' ? null : { frameUrl: null }),
    );
    assert.deepEqual(out.map((c) => c.id), ['archive_good', 'archive_nothumbs', 'archive_photo']);
    assert.match(out[0].thumbnailUrl, /\.thumbs\//);
    assert.match(out[1].thumbnailUrl, /services\/img/);
  });

  it('recognises space subjects without catching cars, phones or product launches', () => {
    for (const q of ['Apollo 11 moon landing', 'Saturn V rocket on the launch pad', 'Mars rover dust', 'astronaut spacewalk', 'earth from space']) {
      assert.ok(SPACE_SUBJECT.test(q), q);
    }
    for (const q of ['Range Rover off road', 'Samsung Galaxy phone on desk', 'product launch event stage', 'Inter Milan training']) {
      assert.ok(!SPACE_SUBJECT.test(q), q);
    }
  });

  it('searches archive.org for films and NASA for space shots', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      urls.push(u);
      if (u.includes('archive.org/advancedsearch')) {
        return new Response(JSON.stringify({ response: { docs: [{ identifier: 'apollo_film', title: 'Saturn V newsreel 1969', mediatype: 'movies' }] } }));
      }
      if (u.includes('archive.org/metadata/')) {
        return new Response(JSON.stringify({ result: [{ name: 'a.mp4', size: '5000000' }, { name: 'a.thumbs/a_000001.jpg' }, { name: 'a.thumbs/a_000002.jpg' }] }));
      }
      if (u.includes('images-api.nasa.gov')) {
        return new Response(
          JSON.stringify({ collection: { items: [{ data: [{ nasa_id: 'as11-launch', title: 'Apollo 11 Launch', media_type: 'video' }], links: [{ href: 'https://images-assets.nasa.gov/x.jpg' }], href: 'https://images-assets.nasa.gov/video/as11/collection.json' }] } }),
        );
      }
      return new Response(JSON.stringify({ query: { pages: {} } }));
    }) as typeof fetch;

    const out = await gatherCandidates({ shot: shot({ visual_query: 'Apollo 11 Saturn V launch 1969', covers: 'The rocket lifts off' }) });
    assert.ok(urls.some((u) => u.includes('mediatype%3Amovies')), 'archive.org is asked for films');
    assert.equal(out[0].provider, 'nasa', 'NASA film comes first for a space shot');
    const archiveFilm = out.find((c) => c.provider === 'archive_org');
    assert.match(archiveFilm!.thumbnailUrl, /a\.thumbs\/a_000001\.jpg$/);

    urls.length = 0;
    await gatherCandidates({ shot: shot() });
    assert.ok(!urls.some((u) => u.includes('nasa.gov')), 'no NASA search for a non-space shot');
  });

  it('prefers film when it fits, and never lets the bonus make an unfit film fit', async () => {
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock-vision-motion',
      supportsVision: true,
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async (req) => {
        assert.match(req.prompt, /a frame from inside the film/);
        return {
          data: {
            ratings: [
              { index: 1, score: 8, era_ok: true, subject_match: true, reason: 'photo' },
              { index: 2, score: 7.5, era_ok: true, subject_match: true, reason: 'film' },
              { index: 3, score: MIN_RELEVANCE - 0.5, era_ok: true, subject_match: true, reason: 'loose film' },
            ],
          },
          usage: {},
        } as never;
      },
    };
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })) as typeof fetch;
    const ranked = await visionRank(
      shot(),
      [
        { ...film('photo'), mediaType: 'image' },
        film('fits', { thumbnailUrl: 'https://archive.org/download/fits/f.thumbs/f_1.jpg' }),
        film('loose'),
      ],
      llm,
      { apiKey: 'k' },
    );
    assert.equal(ranked[0].candidate.id, 'archive_fits');
    assert.equal(ranked[0].score, 7.5 + MOTION_BONUS);
    assert.ok(ranked.find((r) => r.candidate.id === 'archive_loose')!.score < MIN_RELEVANCE);
  });
});
