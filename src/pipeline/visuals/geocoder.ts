export interface GeoCoordinates {
  lat: number;
  lng: number;
  displayName: string;
}

const FALLBACK_CITIES: Record<string, { lat: number; lng: number; displayName: string }> = {
  houston: { lat: 29.7589, lng: -95.3677, displayName: 'Houston, Texas, USA' },
  beaumont: { lat: 30.0802, lng: -94.1266, displayName: 'Beaumont, Texas, USA' },
  austin: { lat: 30.2672, lng: -97.7431, displayName: 'Austin, Texas, USA' },
  dallas: { lat: 32.7767, lng: -96.7970, displayName: 'Dallas, Texas, USA' },
  'new york': { lat: 40.7128, lng: -74.0060, displayName: 'New York City, NY, USA' },
  london: { lat: 51.5074, lng: -0.1278, displayName: 'London, UK' },
  paris: { lat: 48.8566, lng: 2.3522, displayName: 'Paris, France' },
  berlin: { lat: 52.5200, lng: 13.4050, displayName: 'Berlin, Germany' },
  tokyo: { lat: 35.6762, lng: 139.6503, displayName: 'Tokyo, Japan' },
  rome: { lat: 41.9028, lng: 12.4964, displayName: 'Rome, Italy' },
  cairo: { lat: 30.0444, lng: 31.2357, displayName: 'Cairo, Egypt' },
  sydney: { lat: -33.8688, lng: 151.2093, displayName: 'Sydney, Australia' },
  'san francisco': { lat: 37.7749, lng: -122.4194, displayName: 'San Francisco, CA, USA' },
  'silicon valley': { lat: 37.3875, lng: -122.0575, displayName: 'Silicon Valley, CA, USA' },
};

const cache = new Map<string, GeoCoordinates>();

/**
 * Geocodes a place name into latitude and longitude coordinates.
 * Uses OpenStreetMap Nominatim with local dictionary fallbacks.
 */
export async function geocodeLocation(
  query: string,
  signal?: AbortSignal,
): Promise<GeoCoordinates | null> {
  const clean = query.trim();
  if (!clean) return null;

  const lower = clean.toLowerCase();
  if (cache.has(lower)) {
    return cache.get(lower)!;
  }

  // Check built-in fallback dictionary first for common locations
  for (const [key, val] of Object.entries(FALLBACK_CITIES)) {
    if (lower.includes(key)) {
      cache.set(lower, val);
      return val;
    }
  }

  // Query Nominatim API
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', clean);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');

    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'YT-Automation/1.0 (https://github.com)',
        Accept: 'application/json',
      },
      signal,
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const item = data[0];
        const result: GeoCoordinates = {
          lat: parseFloat(item.lat),
          lng: parseFloat(item.lon),
          displayName: item.display_name,
        };
        cache.set(lower, result);
        return result;
      }
    }
  } catch (err) {
    console.warn(`[Geocoder] Nominatim lookup failed for "${clean}":`, err instanceof Error ? err.message : String(err));
  }

  return null;
}
