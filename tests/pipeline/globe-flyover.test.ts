import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { landingImagery, landingTiles, landingZoom, mercatorPx, renderGlobeFlyover } from '../../src/pipeline/visuals/maps/globe-flyover.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { verifyShot } from '../../src/lib/script/shot-planner.ts';
import type { ResolvedPlace } from '../../src/pipeline/visuals/maps/places.ts';
import type { ScriptBeat } from '../../src/lib/script/generate-script.ts';

const execFileAsync = promisify(execFile);
const milan: ResolvedPlace = { label: 'Milan', kind: 'city', lng: 9.19, lat: 45.46 };

describe('Globe flyovers', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'globe-'));
    process.env.TILE_CACHE_DIR = path.join(dir, 'tiles');
  });
  after(async () => {
    delete process.env.TILE_CACHE_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('places points on the Web Mercator grid and chooses how close to land', () => {
    assert.deepEqual(mercatorPx(0, 0, 0), { x: 128, y: 128 });
    const p = mercatorPx(9.19, 45.46, 10);
    assert.equal(Math.floor(p.x / 256), 538, 'the tile column holding Milan at zoom 10');
    assert.equal(Math.floor(p.y / 256), 366);
    assert.equal(landingZoom(milan), 11);
    assert.ok(landingZoom({ label: 'France', kind: 'country', lng: 2, lat: 46, bbox: [-5, 42, 8, 51] }) <= 6, 'a country lands wide');
    const tiles = landingTiles(milan, 11);
    assert.ok(tiles.length >= 40 && tiles.length <= 80, `covers the frame (${tiles.length} tiles)`);
    assert.ok(tiles.some((t) => t.dx <= -1150) && tiles.some((t) => t.dx + 256 >= 1150), 'wide enough for the push in');
  });

  it('fetches the landing tiles once, then reads them from the cache', async () => {
    let calls = 0;
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
    const fake = (async (url: string) => {
      calls++;
      assert.match(String(url), /s2cloudless_3857\/default\/g\/11\/\d+\/\d+\.jpg$/);
      return new Response(jpeg);
    }) as typeof fetch;
    const first = await landingImagery(milan, fake);
    assert.equal(first!.zoom, 11);
    assert.equal(first!.tiles.length, calls);
    assert.match(first!.tiles[0].src, /^data:image\/jpeg;base64,/);
    await landingImagery(milan, fake);
    assert.equal(calls, first!.tiles.length, 'second time from the cache');
  });

  it('ends on the globe when the imagery cannot be had', async () => {
    const offline = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const out = path.join(dir, 'globe.mp4');
    const tokyo: ResolvedPlace = { label: 'Tokyo', kind: 'city', lng: 139.69, lat: 35.69 };
    const { satellite } = await renderGlobeFlyover({ place: tokyo, theme: themeForStyle('documentary'), durationSec: 1, outputPath: out, fetcher: offline });
    assert.equal(satellite, false);
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,nb_frames', '-of', 'csv=p=0', out]);
    assert.match(stdout.trim(), /^1920,1080,30/);
  });

  it('lets the director fly to one place named in the narration', () => {
    const beat: ScriptBeat = { index: 0, text: 'Then the team flew to Tokyo, half a world from Milan.', visual_type: 'stock', visual_query: 'plane', duration_estimate_seconds: 5 };
    const fly = verifyShot({ visual_type: 'geo_map', covers: '', visual_query: 'Tokyo', map: { places: ['Tokyo', 'Milan'], mode: 'fly' } }, beat, []);
    assert.deepEqual(fly.map, { places: ['Tokyo'], mode: 'fly' }, 'a flyover lands on one place');
    const unnamed = verifyShot({ visual_type: 'geo_map', covers: '', visual_query: 'Paris', map: { places: ['Paris'], mode: 'fly' } }, beat, []);
    assert.notEqual(unnamed.visual_type, 'geo_map', 'only places the narration names');
  });
});
