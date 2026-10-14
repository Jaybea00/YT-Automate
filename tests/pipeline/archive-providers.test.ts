import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVisualIntent } from '../../src/pipeline/visuals/intent-classifier';
import { searchWikimediaCommons } from '../../src/pipeline/providers/stock/wikimedia';
import { searchNasa } from '../../src/pipeline/providers/stock/nasa';
import { searchArchiveOrg } from '../../src/pipeline/providers/stock/archive-org';
import { aggregateMediaCandidates } from '../../src/pipeline/visuals/media-aggregator';

test('Multi-Source Open Archive & Candidate Pooling Tests', async (t) => {
  await t.test('1. classifyVisualIntent correctly categorizes intents and distills keywords', () => {
    // Space / NASA
    const spaceResult = classifyVisualIntent('The Apollo mission landed humans on the Moon in 1969.');
    assert.equal(spaceResult.intent, 'nasa_space');
    assert.ok(spaceResult.keywords.length > 0);

    // Archive / Historical
    const historyResult = classifyVisualIntent('In the 19th century, industrial revolution transformed European cities.');
    assert.equal(historyResult.intent, 'archive');

    // Geo / Map
    const geoResult = classifyVisualIntent('The army advanced 40 miles east towards the river.');
    assert.equal(geoResult.intent, 'geo_map');

    // Explicit chart
    const chartResult = classifyVisualIntent('Quarterly revenue grew by 35%', undefined, 'chart');
    assert.equal(chartResult.intent, 'chart');

    // General stock
    const stockResult = classifyVisualIntent('Modern business professionals collaborating in a sleek glass office.');
    assert.equal(stockResult.intent, 'stock');
  });

  await t.test('2. searchWikimediaCommons parses valid candidates and filters out svg and logos', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            query: {
              pages: {
                101: {
                  pageid: 101,
                  title: 'File:Einstein_patent_office.jpg',
                  imageinfo: [
                    {
                      url: 'https://upload.wikimedia.org/wikipedia/commons/e/einstein.jpg',
                      thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/einstein_thumb.jpg',
                      mime: 'image/jpeg',
                      width: 1920,
                      height: 1080,
                      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Einstein_patent_office.jpg',
                      extmetadata: {
                        LicenseShortName: { value: 'Public domain' },
                        Artist: { value: 'Lucien Chavan' },
                        ImageDescription: { value: 'Albert Einstein at Bern patent office' },
                      },
                    },
                  ],
                },
                102: {
                  pageid: 102,
                  title: 'File:Flag of Switzerland.svg',
                  imageinfo: [
                    {
                      url: 'https://upload.wikimedia.org/flag.svg',
                      mime: 'image/svg+xml',
                      width: 500,
                      height: 500,
                    },
                  ],
                },
              },
            },
          }),
        } as any;
      };

      const candidates = await searchWikimediaCommons('Einstein', { limit: 5 });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].provider, 'wikimedia');
      assert.equal(candidates[0].mediaType, 'image');
      assert.equal(candidates[0].license, 'Public domain');
      assert.ok(candidates[0].attribution?.includes('Lucien Chavan'));
      assert.equal(candidates[0].downloadUrl, 'https://upload.wikimedia.org/wikipedia/commons/e/einstein.jpg');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('3. searchNasa parses NASA image and video library hits', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            collection: {
              items: [
                {
                  data: [
                    {
                      nasa_id: 'PIA12345',
                      title: 'Curiosity Rover on Gale Crater',
                      media_type: 'image',
                      description: 'Mars exploration image',
                    },
                  ],
                  links: [{ href: 'https://images-assets.nasa.gov/thumb.jpg' }],
                  href: 'https://images-assets.nasa.gov/collection.json',
                },
              ],
            },
          }),
        } as any;
      };

      const candidates = await searchNasa('Curiosity Rover', { limit: 3 });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].provider, 'nasa');
      assert.equal(candidates[0].title, 'Curiosity Rover on Gale Crater');
      assert.equal(candidates[0].license, 'Public Domain');
      assert.equal(candidates[0].thumbnailUrl, 'https://images-assets.nasa.gov/thumb.jpg');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('4. searchArchiveOrg parses Internet Archive items', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            response: {
              docs: [
                {
                  identifier: 'Apollo11Newsreel',
                  title: 'Apollo 11 Liftoff Archival Reel',
                  mediatype: 'movies',
                  licenseurl: 'http://creativecommons.org/licenses/publicdomain/',
                },
              ],
            },
          }),
        } as any;
      };

      const candidates = await searchArchiveOrg('Apollo 11', { limit: 2 });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].provider, 'archive_org');
      assert.equal(candidates[0].mediaType, 'video');
      assert.ok(candidates[0].pageUrl?.includes('Apollo11Newsreel'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('5. aggregateMediaCandidates routes queries by intent and respects limit', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('images-api.nasa.gov')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              collection: {
                items: [
                  {
                    data: [{ nasa_id: 'N1', title: 'Moon 1', media_type: 'image' }],
                    links: [{ href: 'https://thumb1.jpg' }],
                    href: 'https://collection1.json',
                  },
                  {
                    data: [{ nasa_id: 'N2', title: 'Moon 2', media_type: 'image' }],
                    links: [{ href: 'https://thumb2.jpg' }],
                    href: 'https://collection2.json',
                  },
                ],
              },
            }),
          } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ query: { pages: {} } }),
        } as any;
      };

      const { candidates, intent } = await aggregateMediaCandidates({
        query: 'Moon landing',
        text: 'Astronauts walked on the lunar surface during the Apollo program',
        limit: 2,
      });

      assert.equal(intent, 'nasa_space');
      assert.equal(candidates.length, 2);
      assert.equal(candidates[0].provider, 'nasa');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('6. normalizeLicenseType maps raw licenses to allowed enum values', async () => {
    const { normalizeLicenseType } = await import('../../src/pipeline/utils/media-upload');

    // Creative Commons variations
    // ShareAlike is recorded as such; NC/ND are rejected before normalizing (see isUnusableLicense)
    assert.equal(normalizeLicenseType('CC BY-SA 4.0'), 'cc_by_sa');
    assert.equal(normalizeLicenseType('https://creativecommons.org/licenses/by-sa/3.0/'), 'cc_by_sa');
    assert.equal(normalizeLicenseType('CC BY 3.0'), 'cc_by');
    assert.equal(normalizeLicenseType('https://creativecommons.org/licenses/by/4.0/'), 'cc_by');
    assert.equal(normalizeLicenseType('cc_by'), 'cc_by');

    // CC0
    assert.equal(normalizeLicenseType('CC0'), 'cc0');
    assert.equal(normalizeLicenseType('CC0 1.0 Universal'), 'cc0');
    assert.equal(normalizeLicenseType('https://creativecommons.org/publicdomain/zero/1.0/'), 'cc0');

    // Public Domain
    assert.equal(normalizeLicenseType('Public domain'), 'public_domain');
    assert.equal(normalizeLicenseType('public_domain'), 'public_domain');
    assert.equal(normalizeLicenseType('Public domain / CC'), 'public_domain');
    assert.equal(normalizeLicenseType('http://creativecommons.org/licenses/publicdomain/'), 'public_domain');
    assert.equal(normalizeLicenseType('PD-USGov'), 'public_domain');

    // Royalty Free / Stock
    assert.equal(normalizeLicenseType('Pexels License'), 'royalty_free');
    assert.equal(normalizeLicenseType('Pixabay Content License'), 'royalty_free');
    assert.equal(normalizeLicenseType(null), 'royalty_free');
    assert.equal(normalizeLicenseType(undefined), 'royalty_free');
    assert.equal(normalizeLicenseType(''), 'royalty_free');

    // Fair Use, Own work, Purchased
    assert.equal(normalizeLicenseType('Fair Use'), 'fair_use');
    assert.equal(normalizeLicenseType('own_work'), 'own_work');
    assert.equal(normalizeLicenseType('Commercial purchase'), 'purchased');

    const { isUnusableLicense } = await import('../../src/pipeline/utils/media-upload');
    for (const unusable of ['CC-BY-NC 2.0', 'CC BY-NC-SA 4.0', 'https://creativecommons.org/licenses/by-nd/4.0/', 'Attribution-NonCommercial']) {
      assert.equal(isUnusableLicense(unusable), true, unusable);
    }
    for (const usable of ['CC BY-SA 4.0', 'CC0', 'Public domain', 'Pixabay Content License', null]) {
      assert.equal(isUnusableLicense(usable), false, String(usable));
    }
  });
});

