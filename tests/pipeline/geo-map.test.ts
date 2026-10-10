import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  extractGeoEntities,
  buildAnimatedMapHtml,
  executeGeoMapStep,
} from '../../src/pipeline/visuals/geo-map-step';
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

  await t.test('3. buildAnimatedMapHtml generates valid Leaflet HTML with glowing markers', () => {
    const html = buildAnimatedMapHtml({
      origin: { lat: 29.76, lng: -95.36, displayName: 'Houston, TX' },
      dest: { lat: 30.08, lng: -94.12, displayName: 'Beaumont, TX' },
      isRoute: true,
      label: 'Houston → Beaumont',
      durationSeconds: 3,
    });

    assert.ok(html.includes('leaflet.js'));
    assert.ok(html.includes('pulse-ring'));
    assert.ok(html.includes('29.76'));
    assert.ok(html.includes('-95.36'));
    assert.ok(html.includes('polyline'));
    assert.ok(html.includes('flyToBounds'));
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
