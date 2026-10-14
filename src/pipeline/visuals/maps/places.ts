import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { geoArea, geoBounds, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { Topology } from 'topojson-specification';

/**
 * Turns place names from a shot plan into map geometry. Offline first (continents, countries,
 * major cities, all matched exactly), then OpenStreetMap Nominatim restricted to settlements and
 * administrative areas, so a name can never resolve to a park, shop or street.
 */

export type PlaceKind = 'continent' | 'country' | 'region' | 'city';
/** [west, south, east, north] in degrees. */
export type BBox = [number, number, number, number];

export interface ResolvedPlace {
  /** The name as the narration says it; used for the label. */
  label: string;
  kind: PlaceKind;
  lng: number;
  lat: number;
  bbox?: BBox;
  /** Country feature id, to highlight its shape. */
  countryId?: string;
}

export type CountryFeature = Feature<Polygon | MultiPolygon, { name: string }>;

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();

// --------------------------------------------------------------------------
// Countries (Natural Earth 1:50m via world-atlas)
// --------------------------------------------------------------------------

/** 1:50m for continental and world views; 1:10m coastlines for close-ups. */
export type MapResolution = '50m' | '10m';
const countriesCache = new Map<MapResolution, CountryFeature[]>();

/** Countries keyed by name (`id`), which is the same at every resolution. */
export function loadCountries(resolution: MapResolution = '50m'): CountryFeature[] {
  const cached = countriesCache.get(resolution);
  if (cached) return cached;
  const req = createRequire(path.join(process.cwd(), 'package.json'));
  const file = req.resolve(`world-atlas/countries-${resolution}.json`);
  const topology = JSON.parse(fs.readFileSync(file, 'utf-8')) as Topology;
  const collection = feature(topology, topology.objects.countries) as unknown as FeatureCollection<Polygon | MultiPolygon, { name: string }>;
  const countries = collection.features.map((f) => ({ ...f, id: f.properties.name, geometry: fixWinding(f.geometry) }));
  countriesCache.set(resolution, countries);
  return countries;
}

/**
 * Reverses any polygon wound the wrong way. On a sphere a backwards ring means "everything but
 * this shape", so one bad island (the Maldives in the 1:10m data) would paint the whole map as
 * land. No country covers a hemisphere, so anything larger is a winding error.
 */
function fixWinding(geometry: Polygon | MultiPolygon): Polygon | MultiPolygon {
  const fix = (rings: Polygon['coordinates']) =>
    geoArea({ type: 'Polygon', coordinates: rings }) > 2 * Math.PI ? rings.map((r) => [...r].reverse()) : rings;
  return geometry.type === 'Polygon'
    ? { ...geometry, coordinates: fix(geometry.coordinates) }
    : { ...geometry, coordinates: geometry.coordinates.map(fix) };
}

/**
 * The country's main landmass: its largest polygon. Centroids and camera framing use it, so
 * France is framed on Europe rather than averaged with French Guiana, and the USA on the lower 48.
 */
export function mainland(country: CountryFeature): Feature<Polygon> {
  const g = country.geometry;
  if (g.type === 'Polygon') return { type: 'Feature', properties: {}, geometry: g };
  let best: Feature<Polygon> | null = null;
  let bestArea = -1;
  for (const coords of g.coordinates) {
    const poly: Feature<Polygon> = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: coords } };
    const area = geoArea(poly);
    if (area > bestArea) {
      bestArea = area;
      best = poly;
    }
  }
  return best!;
}

const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'United States of America',
  us: 'United States of America',
  'united states': 'United States of America',
  america: 'United States of America',
  uk: 'United Kingdom',
  britain: 'United Kingdom',
  'great britain': 'United Kingdom',
  england: 'United Kingdom',
  scotland: 'United Kingdom',
  wales: 'United Kingdom',
  'soviet union': 'Russia',
  ussr: 'Russia',
  'russian federation': 'Russia',
  holland: 'Netherlands',
  'czech republic': 'Czechia',
  'ivory coast': "Côte d'Ivoire",
  'cote divoire': "Côte d'Ivoire",
  drc: 'Dem. Rep. Congo',
  'democratic republic of the congo': 'Dem. Rep. Congo',
  'dr congo': 'Dem. Rep. Congo',
  'republic of the congo': 'Congo',
  bosnia: 'Bosnia and Herz.',
  'bosnia and herzegovina': 'Bosnia and Herz.',
  burma: 'Myanmar',
  persia: 'Iran',
  'dominican republic': 'Dominican Rep.',
  swaziland: 'eSwatini',
  eswatini: 'eSwatini',
  uae: 'United Arab Emirates',
  'north macedonia': 'Macedonia',
  'central african republic': 'Central African Rep.',
  'south sudan': 'S. Sudan',
  'equatorial guinea': 'Eq. Guinea',
  'solomon islands': 'Solomon Is.',
  'east timor': 'Timor-Leste',
  prc: 'China',
  "people's republic of china": 'China',
  'republic of korea': 'South Korea',
  dprk: 'North Korea',
  'west germany': 'Germany',
  'east germany': 'Germany',
  ceylon: 'Sri Lanka',
  siam: 'Thailand',
  rhodesia: 'Zimbabwe',
  zaire: 'Dem. Rep. Congo',
};

export function findCountry(name: string): CountryFeature | null {
  const key = normalize(name);
  if (!key) return null;
  const target = normalize(COUNTRY_ALIASES[key] ?? name);
  return loadCountries().find((c) => normalize(c.properties.name) === target) ?? null;
}

function countryPlace(label: string, country: CountryFeature): ResolvedPlace {
  const main = mainland(country);
  const [lng, lat] = geoCentroid(main);
  const [[w, s], [e, n]] = geoBounds(main);
  return { label, kind: 'country', lng, lat, bbox: [w, s, e, n], countryId: String(country.id) };
}

// --------------------------------------------------------------------------
// Continents and well-known regions (approximate frames, no outline)
// --------------------------------------------------------------------------

const REGIONS: Record<string, BBox> = {
  europe: [-12, 35, 42, 66],
  'western europe': [-11, 36, 17, 60],
  'eastern europe': [13, 41, 50, 62],
  asia: [26, -10, 146, 72],
  'east asia': [73, 18, 146, 54],
  'southeast asia': [92, -11, 141, 28],
  'south asia': [60, 5, 98, 37],
  'central asia': [46, 35, 88, 56],
  africa: [-18, -35, 52, 37],
  'west africa': [-18, 4, 16, 25],
  'east africa': [28, -12, 52, 16],
  'north africa': [-17, 15, 35, 37],
  'sub saharan africa': [-18, -35, 52, 18],
  'north america': [-168, 7, -52, 72],
  'south america': [-82, -56, -34, 13],
  'latin america': [-118, -56, -34, 32],
  'central america': [-93, 7, -77, 19],
  caribbean: [-86, 10, -59, 27],
  'middle east': [25, 12, 63, 42],
  'persian gulf': [47, 23, 57, 31],
  'the gulf': [47, 23, 57, 31],
  oceania: [110, -48, 180, 0],
  australasia: [110, -48, 179, -9],
  scandinavia: [4, 54, 32, 71],
  balkans: [13, 39, 30, 47],
  mediterranean: [-6, 30, 36, 46],
  'arctic': [-180, 66, 180, 90],
  'pacific': [120, -40, 250, 50],
  'atlantic': [-80, -40, 10, 60],
  'indian ocean': [40, -40, 110, 25],
};

const CONTINENTS = new Set(['europe', 'asia', 'africa', 'north america', 'south america', 'oceania']);

// --------------------------------------------------------------------------
// Major cities (offline, exact match)
// --------------------------------------------------------------------------

const CITIES: Record<string, [number, number]> = {
  'new york': [-74.006, 40.7128],
  'new york city': [-74.006, 40.7128],
  nyc: [-74.006, 40.7128],
  manhattan: [-73.9712, 40.7831],
  washington: [-77.0369, 38.9072],
  'washington dc': [-77.0369, 38.9072],
  boston: [-71.0589, 42.3601],
  chicago: [-87.6298, 41.8781],
  detroit: [-83.0458, 42.3314],
  'los angeles': [-118.2437, 34.0522],
  'san francisco': [-122.4194, 37.7749],
  'silicon valley': [-122.0575, 37.3875],
  seattle: [-122.3321, 47.6062],
  houston: [-95.3698, 29.7604],
  dallas: [-96.797, 32.7767],
  austin: [-97.7431, 30.2672],
  miami: [-80.1918, 25.7617],
  atlanta: [-84.388, 33.749],
  philadelphia: [-75.1652, 39.9526],
  'las vegas': [-115.1398, 36.1699],
  toronto: [-79.3832, 43.6532],
  montreal: [-73.5673, 45.5017],
  vancouver: [-123.1207, 49.2827],
  'mexico city': [-99.1332, 19.4326],
  havana: [-82.3666, 23.1136],
  'sao paulo': [-46.6333, -23.5505],
  'rio de janeiro': [-43.1729, -22.9068],
  'buenos aires': [-58.3816, -34.6037],
  lima: [-77.0428, -12.0464],
  bogota: [-74.0721, 4.711],
  santiago: [-70.6693, -33.4489],
  caracas: [-66.9036, 10.4806],
  london: [-0.1276, 51.5072],
  paris: [2.3522, 48.8566],
  berlin: [13.405, 52.52],
  madrid: [-3.7038, 40.4168],
  barcelona: [2.1734, 41.3851],
  lisbon: [-9.1393, 38.7223],
  rome: [12.4964, 41.9028],
  milan: [9.19, 45.4642],
  vienna: [16.3738, 48.2082],
  amsterdam: [4.9041, 52.3676],
  brussels: [4.3517, 50.8503],
  zurich: [8.5417, 47.3769],
  geneva: [6.1432, 46.2044],
  frankfurt: [8.6821, 50.1109],
  munich: [11.582, 48.1351],
  hamburg: [9.9937, 53.5511],
  stockholm: [18.0686, 59.3293],
  oslo: [10.7522, 59.9139],
  copenhagen: [12.5683, 55.6761],
  helsinki: [24.9384, 60.1699],
  dublin: [-6.2603, 53.3498],
  edinburgh: [-3.1883, 55.9533],
  warsaw: [21.0122, 52.2297],
  prague: [14.4378, 50.0755],
  budapest: [19.0402, 47.4979],
  athens: [23.7275, 37.9838],
  istanbul: [28.9784, 41.0082],
  constantinople: [28.9784, 41.0082],
  moscow: [37.6173, 55.7558],
  'st petersburg': [30.3351, 59.9343],
  'saint petersburg': [30.3351, 59.9343],
  leningrad: [30.3351, 59.9343],
  kyiv: [30.5234, 50.4501],
  kiev: [30.5234, 50.4501],
  cairo: [31.2357, 30.0444],
  lagos: [3.3792, 6.5244],
  abuja: [7.4951, 9.0765],
  nairobi: [36.8219, -1.2921],
  johannesburg: [28.0473, -26.2041],
  'cape town': [18.4241, -33.9249],
  casablanca: [-7.5898, 33.5731],
  accra: [-0.187, 5.6037],
  'addis ababa': [38.7578, 8.9806],
  kinshasa: [15.2663, -4.4419],
  dubai: [55.2708, 25.2048],
  'abu dhabi': [54.3773, 24.4539],
  riyadh: [46.6753, 24.7136],
  tehran: [51.389, 35.6892],
  baghdad: [44.3661, 33.3152],
  jerusalem: [35.2137, 31.7683],
  'tel aviv': [34.7818, 32.0853],
  beirut: [35.5018, 33.8938],
  damascus: [36.2765, 33.5138],
  karachi: [67.0011, 24.8607],
  delhi: [77.209, 28.6139],
  'new delhi': [77.209, 28.6139],
  mumbai: [72.8777, 19.076],
  bombay: [72.8777, 19.076],
  bangalore: [77.5946, 12.9716],
  kolkata: [88.3639, 22.5726],
  dhaka: [90.4125, 23.8103],
  bangkok: [100.5018, 13.7563],
  singapore: [103.8198, 1.3521],
  'kuala lumpur': [101.6869, 3.139],
  jakarta: [106.8456, -6.2088],
  manila: [120.9842, 14.5995],
  hanoi: [105.8342, 21.0278],
  saigon: [106.6297, 10.8231],
  'ho chi minh city': [106.6297, 10.8231],
  'hong kong': [114.1694, 22.3193],
  shenzhen: [114.0579, 22.5431],
  shanghai: [121.4737, 31.2304],
  beijing: [116.4074, 39.9042],
  peking: [116.4074, 39.9042],
  taipei: [121.5654, 25.033],
  seoul: [126.978, 37.5665],
  pyongyang: [125.7625, 39.0392],
  tokyo: [139.6503, 35.6762],
  osaka: [135.5023, 34.6937],
  hiroshima: [132.4553, 34.3853],
  nagasaki: [129.8737, 32.7503],
  'pearl harbor': [-157.95, 21.3649],
  honolulu: [-157.8583, 21.3069],
  sydney: [151.2093, -33.8688],
  melbourne: [144.9631, -37.8136],
  auckland: [174.7633, -36.8485],
};

// --------------------------------------------------------------------------
// Nominatim fallback
// --------------------------------------------------------------------------

/** Nominatim result types that are places on a map, not things in a place. */
const PLACE_TYPES = new Set([
  'city', 'town', 'village', 'hamlet', 'municipality', 'borough', 'suburb', 'county', 'state',
  'province', 'region', 'country', 'island', 'archipelago', 'administrative', 'district', 'territory',
]);

let lastNominatimCall = 0;
const nominatimCache = new Map<string, ResolvedPlace | null>();

async function nominatim(label: string, signal?: AbortSignal): Promise<ResolvedPlace | null> {
  const key = normalize(label);
  if (nominatimCache.has(key)) return nominatimCache.get(key)!;
  // Usage policy: at most one request per second
  const wait = lastNominatimCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimCall = Date.now();

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', label);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('featureType', 'settlement');
  url.searchParams.set('accept-language', 'en');
  let result: ResolvedPlace | null = null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'YT-Automation/1.0 (documentary map renderer)', Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const items = (await res.json()) as Array<{ lat: string; lon: string; type?: string; addresstype?: string; category?: string; boundingbox?: string[] }>;
      const item = items.find((i) => PLACE_TYPES.has(i.addresstype ?? '') || PLACE_TYPES.has(i.type ?? ''));
      if (item) {
        const kind: PlaceKind = ['city', 'town', 'village', 'hamlet', 'municipality', 'borough', 'suburb'].includes(item.addresstype ?? item.type ?? '')
          ? 'city'
          : 'region';
        const [s, n, w, e] = (item.boundingbox ?? []).map(Number);
        result = {
          label,
          kind,
          lng: Number(item.lon),
          lat: Number(item.lat),
          bbox: kind === 'region' && [s, n, w, e].every(Number.isFinite) ? [w, s, e, n] : undefined,
        };
      }
    }
  } catch (err) {
    console.warn(`[Places] Nominatim lookup failed for "${label}": ${err instanceof Error ? err.message : err}`);
    return null; // not cached, so a later shot can retry
  }
  nominatimCache.set(key, result);
  return result;
}

/** Resolves one place name, or null when it can't be placed confidently. */
export async function resolvePlace(name: string, signal?: AbortSignal): Promise<ResolvedPlace | null> {
  const label = name.trim();
  const key = normalize(label);
  if (!key) return null;

  const region = REGIONS[key];
  if (region) {
    const [w, s, e, n] = region;
    return { label, kind: CONTINENTS.has(key) ? 'continent' : 'region', lng: (w + e) / 2, lat: (s + n) / 2, bbox: region };
  }
  const country = findCountry(label);
  if (country) return countryPlace(label, country);
  const city = CITIES[key];
  if (city) return { label, kind: 'city', lng: city[0], lat: city[1] };
  return nominatim(label, signal);
}

/** Resolves every place, dropping any that can't be placed. */
export async function resolvePlaces(names: string[], signal?: AbortSignal): Promise<ResolvedPlace[]> {
  const out: ResolvedPlace[] = [];
  for (const name of names) {
    const place = await resolvePlace(name, signal);
    if (place) out.push(place);
  }
  return out;
}
