import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { indicatorByCode, type DataSpec } from '@/lib/data/indicators';

export type { DataSpec };

/**
 * Real figures for charts: series from the World Bank's open data (no key; CC BY 4.0), cached
 * on disk so a chart renders the same way every time and works offline once fetched.
 */

export interface Observation {
  country: string;
  code: string;
  year: number;
  value: number;
}

const API = 'https://api.worldbank.org/v2';
const cacheDir = () => process.env.DATA_CACHE_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'data-cache', 'worldbank');

/** Short country names for charts (the World Bank's are long: "Korea, Rep."). */
const SHORT_NAMES: Record<string, string> = {
  USA: 'USA',
  GBR: 'UK',
  KOR: 'South Korea',
  PRK: 'North Korea',
  RUS: 'Russia',
  IRN: 'Iran',
  EGY: 'Egypt',
  VEN: 'Venezuela',
  SYR: 'Syria',
  YEM: 'Yemen',
  TUR: 'Turkey',
  HKG: 'Hong Kong',
  LAO: 'Laos',
  SVK: 'Slovakia',
  CZE: 'Czechia',
  COD: 'DR Congo',
  COG: 'Congo',
  GMB: 'Gambia',
  BHS: 'Bahamas',
  KGZ: 'Kyrgyzstan',
  MKD: 'North Macedonia',
  WLD: 'World',
  EUU: 'EU',
};

/** The observations for a spec (cached). Missing years are simply absent. */
export async function fetchObservations(spec: DataSpec, fetcher: typeof fetch = fetch): Promise<Observation[]> {
  const key = createHash('sha1').update(JSON.stringify([spec.indicator, [...spec.countries].sort(), spec.from_year, spec.to_year])).digest('hex').slice(0, 16);
  const file = path.join(cacheDir(), `${key}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as Observation[];
  } catch {
    // not cached yet
  }
  const url = `${API}/country/${spec.countries.join(';')}/indicator/${spec.indicator}?format=json&date=${spec.from_year}:${spec.to_year}&per_page=5000`;
  const res = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`World Bank data unavailable (${res.status})`);
  const body = (await res.json()) as [unknown, Array<{ countryiso3code: string; country: { value: string }; date: string; value: number | null }> | null];
  const rows = (Array.isArray(body) && Array.isArray(body[1]) ? body[1] : [])
    .filter((r) => r.value !== null && Number.isFinite(r.value) && /^\d{4}$/.test(r.date))
    .map((r) => ({ code: r.countryiso3code, country: SHORT_NAMES[r.countryiso3code] ?? r.country.value, year: Number(r.date), value: r.value as number }));
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(file, JSON.stringify(rows), 'utf-8');
  return rows;
}

const round = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

/** A trend or comparison as chart data. */
export function chartFromObservations(spec: DataSpec, rows: Observation[]): { chart_type: 'line' | 'bar'; title: string; unit: string; labels: string[]; values: number[] } | null {
  const ind = indicatorByCode(spec.indicator)!;
  const scale = ind.scale ?? 1;
  if (spec.kind === 'trend') {
    const code = spec.countries[0];
    const series = rows.filter((r) => r.code === code).sort((a, b) => a.year - b.year);
    if (series.length < 3) return null;
    // At most 12 points: evenly spread, always keeping the first and last years
    const step = Math.max(1, Math.ceil((series.length - 1) / 11));
    const picked = series.filter((_, i) => i % step === 0 || i === series.length - 1);
    return {
      chart_type: 'line',
      title: `${ind.label}: ${series[0].country}`,
      unit: `${ind.unit}, ${series[0].year}-${series[series.length - 1].year}`,
      labels: picked.map((r) => String(r.year)),
      values: picked.map((r) => round(r.value / scale)),
    };
  }
  // compare: each country's latest figure in range, largest first
  const latest = new Map<string, Observation>();
  for (const r of rows) if (!latest.has(r.code) || latest.get(r.code)!.year < r.year) latest.set(r.code, r);
  const items = [...latest.values()].sort((a, b) => b.value - a.value);
  if (items.length < 2) return null;
  const years = [...new Set(items.map((r) => r.year))];
  return {
    chart_type: 'bar',
    title: ind.label,
    unit: `${ind.unit}, ${years.length === 1 ? years[0] : `latest year (${Math.min(...years)}-${Math.max(...years)})`}`,
    labels: items.map((r) => r.country),
    values: items.map((r) => round(r.value / scale)),
  };
}

export interface RaceData {
  title: string;
  unit: string;
  /** Each year's values by country; gaps carried forward from the last known year. */
  frames: Array<{ year: number; values: Record<string, number> }>;
}

/** A bar-chart race: every country's value year by year. */
export function raceFromObservations(spec: DataSpec, rows: Observation[]): RaceData | null {
  const ind = indicatorByCode(spec.indicator)!;
  const scale = ind.scale ?? 1;
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
  if (years.length < 3) return null;
  const names = [...new Set(rows.map((r) => r.country))];
  if (names.length < 2) return null;
  const last: Record<string, number> = {};
  const frames = years.map((year) => {
    for (const r of rows) if (r.year === year) last[r.country] = round(r.value / scale);
    return { year, values: { ...last } };
  });
  // Start where every country has a value, so no bar appears from nowhere mid-race
  const first = frames.findIndex((f) => names.every((n) => f.values[n] !== undefined));
  const usable = frames.slice(Math.max(0, first));
  if (usable.length < 3) return null;
  return { title: ind.label, unit: ind.unit, frames: usable };
}
