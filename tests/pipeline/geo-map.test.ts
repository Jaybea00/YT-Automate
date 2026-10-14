import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { geoArea } from 'd3-geo';
import { extractGeoEntities, executeGeoMapStep } from '../../src/pipeline/visuals/geo-map-step';
import { loadCountries, resolvePlace, resolvePlaces } from '../../src/pipeline/visuals/maps/places';
import { buildMapScene } from '../../src/pipeline/visuals/maps/map-scene';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme';
import { geocodeLocation } from '../../src/pipeline/visuals/geocoder';
import { getVideoDurationMs } from '../../src/pipeline/utils/ffmpeg';

test('Geo-Data Extraction & Animated Map Generator Tests', async (t) => {
  const tempDir = path.join(process.cwd(), 'storage', 'test_geo_map');
  await fs.mkdir(tempDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('1. extractGeoEntities extracts route, offset, and single locations', () => {
    // Route
    const route = extractGeoEntities('The express train travels from Paris to Berlin every morning.');
    assert.equal(route.isRoute, true);
    assert.equal(route.origin, 'Paris');
    assert.equal(route.destination, 'Berlin');
    assert.ok(route.label?.includes('Paris'));

    // Distance offset
    const offset = extractGeoEntities('The facility was built 40 miles east of Houston.');
    assert.equal(offset.isRoute, false);
    assert.equal(offset.origin, 'Houston');
    assert.equal(offset.label, '40 miles east of');

    // Single city
    const single = extractGeoEntities('The headquarters are located in Tokyo.');
    assert.equal(single.isRoute, false);
    assert.equal(single.origin, 'Tokyo');
  });

  await t.test('2. geocodeLocation resolves coordinates with caching and fallbacks', async () => {
    const houston = await geocodeLocation('Houston');
    assert.ok(houston);
    assert.ok(Math.abs(houston.lat - 29.75) < 0.2);
    assert.ok(Math.abs(houston.lng - -95.36) < 0.2);

    const paris = await geocodeLocation('Paris');
    assert.ok(paris);
    assert.ok(Math.abs(paris.lat - 48.85) < 0.2);

    // Empty query returns null
    const empty = await geocodeLocation('');
    assert.equal(empty, null);
  });

  await t.test('3. places resolve offline and build a self-contained animated map', async () => {
    const places = await resolvePlaces(['Houston', 'Beaumont']);
    assert.deepEqual(places.map((p) => p.kind), ['city', 'city']);

    const usa = await resolvePlace('the USA');
    assert.equal(usa?.kind, 'country');
    assert.equal(usa?.countryId, 'United States of America');
    assert.ok(usa && usa.lng < -80 && usa.lng > -110, 'framed on the lower 48, not averaged with Alaska');
    assert.equal((await resolvePlace('Europe'))?.kind, 'continent');

    const scene = buildMapScene({ places, mode: 'route', theme: themeForStyle('vox_explainer') });
    const html = scene.page('data:image/jpeg;base64,');
    assert.ok(scene.baseSvg.includes('class="land"'));
    assert.ok(html.includes('window.__frame'));
    assert.ok(html.includes('id="arc0"'), 'route draws an arc');
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), 'no network resources');
  });

  await t.test('3b. no country shape covers the globe (winding errors in the source data are repaired)', () => {
    for (const res of ['50m', '10m'] as const) {
      const inverted = loadCountries(res).filter((c) => geoArea(c) > 2 * Math.PI);
      assert.deepEqual(inverted.map((c) => c.properties.name), [], `${res} data`);
    }
  });

  await t.test('4. executeGeoMapStep generates 1080p MP4 with Playwright and FFmpeg', async () => {
    const outMp4 = path.join(tempDir, 'houston_map.mp4');

    const result = await executeGeoMapStep({
      text: 'The distribution center is located 40 miles east of Houston.',
      durationSeconds: 2,
      outputMp4Path: outMp4,
      tempDir: path.join(tempDir, 'work'),
    });

    assert.equal(result.success, true);
    assert.ok(result.outputPath);

    // Verify MP4 file was created on disk and has duration
    const stat = await fs.stat(outMp4);
    assert.ok(stat.size > 1000, 'Expected non-empty MP4 file');

    const durationMs = await getVideoDurationMs(outMp4);
    assert.ok(durationMs >= 1500, `Expected duration >= 1500ms, got ${durationMs}`);
  });
});
