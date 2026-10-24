import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeDataSpec } from '../../src/lib/data/indicators.ts';
import { chartFromObservations, fetchObservations, raceFromObservations, type Observation } from '../../src/pipeline/visuals/real-data.ts';
import { sourceTagFor } from '../../src/pipeline/visuals/source-tags.ts';
import { barRaceTemplate } from '../../src/pipeline/visuals/motion/data-templates.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';

const obs = (code: string, country: string, year: number, value: number): Observation => ({ code, country, year, value });

describe('Real-data charts (World Bank)', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-'));
    process.env.DATA_CACHE_DIR = dir;
  });
  after(async () => {
    delete process.env.DATA_CACHE_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('accepts only drawable specs', () => {
    assert.deepEqual(normalizeDataSpec({ indicator: 'NY.GDP.PCAP.CD', countries: ['gbr', 'FRA', 'GBR'], from_year: 2000, to_year: 2099, kind: 'compare' }, 2025), {
      indicator: 'NY.GDP.PCAP.CD',
      countries: ['GBR', 'FRA'],
      from_year: 2000,
      to_year: 2025,
      kind: 'compare',
    });
    assert.equal(normalizeDataSpec({ indicator: 'MADE.UP', countries: ['GBR'], kind: 'trend' }), null, 'only listed indicators');
    assert.equal(normalizeDataSpec({ indicator: 'SP.POP.TOTL', countries: ['GBR', 'FRA'], kind: 'trend', from_year: 2000, to_year: 2020 }), null, 'a trend is one country');
    assert.equal(normalizeDataSpec({ indicator: 'SP.POP.TOTL', countries: ['GBR'], kind: 'race', from_year: 2000, to_year: 2020 }), null, 'a race needs rivals');
    assert.equal(normalizeDataSpec({ indicator: 'SP.POP.TOTL', countries: ['Britain'], kind: 'trend' }), null);
  });

  it('turns observations into a trend, a comparison and a race', () => {
    const rows = [
      ...[2000, 2005, 2010, 2015, 2020].map((y, i) => obs('KOR', 'South Korea', y, 10000 + i * 5000)),
      ...[2000, 2005, 2010, 2015, 2020].map((y, i) => obs('POL', 'Poland', y, 4000 + i * 3500)),
      obs('IND', 'India', 2005, 700),
      obs('IND', 'India', 2020, 1900),
    ];
    const trend = chartFromObservations({ indicator: 'NY.GDP.PCAP.CD', countries: ['KOR'], from_year: 2000, to_year: 2020, kind: 'trend' }, rows)!;
    assert.deepEqual([trend.chart_type, trend.labels, trend.values], ['line', ['2000', '2005', '2010', '2015', '2020'], [10000, 15000, 20000, 25000, 30000]]);
    assert.equal(trend.title, 'GDP per person: South Korea');

    const cmp = chartFromObservations({ indicator: 'NY.GDP.PCAP.CD', countries: ['KOR', 'POL', 'IND'], from_year: 2000, to_year: 2020, kind: 'compare' }, rows)!;
    assert.deepEqual([cmp.labels, cmp.values], [['South Korea', 'Poland', 'India'], [30000, 18000, 1900]]);
    assert.match(cmp.unit, /2020/);

    const race = raceFromObservations({ indicator: 'NY.GDP.PCAP.CD', countries: ['KOR', 'POL', 'IND'], from_year: 2000, to_year: 2020, kind: 'race' }, rows)!;
    assert.equal(race.frames[0].year, 2005, 'starts when every country has a value');
    assert.deepEqual(race.frames.find((f) => f.year === 2010)!.values, { 'South Korea': 20000, Poland: 11000, India: 700 }, "India's last value carries forward");
    assert.match(barRaceTemplate(themeForStyle('finance'), race), /window\.__frame/);
  });

  it('fetches from the World Bank once, then reads the cache', async () => {
    let calls = 0;
    const fake = (async (url: string) => {
      calls++;
      assert.match(String(url), /country\/GBR;FRA\/indicator\/SP\.POP\.TOTL\?format=json&date=2019:2020/);
      return new Response(
        JSON.stringify([
          { page: 1 },
          [
            { countryiso3code: 'GBR', country: { value: 'United Kingdom' }, date: '2020', value: 67081000 },
            { countryiso3code: 'FRA', country: { value: 'France' }, date: '2020', value: 67571000 },
            { countryiso3code: 'FRA', country: { value: 'France' }, date: '2019', value: null },
          ],
        ]),
      );
    }) as typeof fetch;
    const spec = { indicator: 'SP.POP.TOTL', countries: ['GBR', 'FRA'], from_year: 2019, to_year: 2020, kind: 'compare' as const };
    const rows = await fetchObservations(spec, fake);
    assert.deepEqual(rows.map((r) => [r.country, r.year]), [['UK', 2020], ['France', 2020]], 'short names, empty years dropped');
    await fetchObservations(spec, fake);
    assert.equal(calls, 1);
  });

  it('tags real-data charts as World Bank figures', () => {
    const shot = { visual_type: 'chart' as const, chart: { chart_type: 'bar' as const, title: '', labels: [], values: [], data: { indicator: 'SP.POP.TOTL', countries: ['GBR', 'FRA'], from_year: 2000, to_year: 2020, kind: 'compare' as const } } };
    assert.equal(sourceTagFor(shot, null), 'Source: World Bank');
  });
});
