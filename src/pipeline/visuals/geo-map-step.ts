import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Browser } from 'playwright';
import type { GeoCoordinates } from './geocoder';
import { renderMapClip } from './maps/map-clip';
import { resolvePlaces } from './maps/places';
import { themeForStyle, type MotionTheme } from './motion/theme';

export interface GeoMapStepInput {
  text: string;
  visualQuery?: string;
  durationSeconds: number;
  outputMp4Path: string;
  /** Unused since maps render offline; kept for callers. */
  tempDir: string;
  browser?: Browser;
  theme?: MotionTheme;
}

export interface GeoMapStepResult {
  success: boolean;
  outputPath?: string;
  coordinates?: GeoCoordinates;
  error?: string;
}

function cleanPlaceName(raw: string): string {
  const words = raw.trim().split(/\s+/);
  const stopTail = new Set([
    'every', 'each', 'all', 'during', 'in', 'on', 'at', 'with', 'and',
    'morning', 'afternoon', 'night', 'day', 'daily', 'yearly', 'towards',
    'everywhere', 'constantly',
  ]);
  const filtered: string[] = [];
  for (const w of words) {
    if (stopTail.has(w.toLowerCase())) break;
    filtered.push(w);
    if (filtered.length >= 3) break;
  }
  return filtered.join(' ').trim() || raw.trim();
}

/**
 * Extracts candidate place names from text or visual query using heuristics.
 */
export function extractGeoEntities(text: string, visualQuery?: string): {
  origin: string;
  destination?: string;
  isRoute: boolean;
  label?: string;
} {
  const combined = `${visualQuery || ''} ${text}`;

  // Check route: "from [A] to [B]"
  const routeMatch = combined.match(/from\s+([A-Za-z\s]+?)\s+to\s+([A-Za-z\s]+?)(?:[.,;]|$)/i);
  if (routeMatch) {
    const orig = cleanPlaceName(routeMatch[1]);
    const dest = cleanPlaceName(routeMatch[2]);
    return {
      origin: orig,
      destination: dest,
      isRoute: true,
      label: `${orig} → ${dest}`,
    };
  }

  // Check offset: "[X] miles east/west/north/south of [A]"
  const offsetMatch = combined.match(/(\d+\s*miles?\s+(?:east|west|north|south)(?:\s+of)?)\s+([A-Za-z\s]+?)(?:[.,;]|$)/i);
  if (offsetMatch) {
    const orig = cleanPlaceName(offsetMatch[2]);
    return {
      origin: orig,
      isRoute: false,
      label: offsetMatch[1].trim(),
    };
  }

  // Check "located in [A]" or "in [A]"
  const inMatch = combined.match(/(?:located in|outside|near|across)\s+([A-Za-z\s]+?)(?:[.,;]|$)/i);
  if (inMatch) {
    const orig = cleanPlaceName(inMatch[1]);
    return {
      origin: orig,
      isRoute: false,
      label: orig,
    };
  }

  return {
    origin: cleanPlaceName(visualQuery?.trim() || text.split(/[,.]/)[0].trim()),
    isRoute: false,
  };
}

/**
 * Executes the full animated map generation step: extracts place names, places them offline
 * (Natural Earth shapes, a city gazetteer, Nominatim settlements as a fallback), and renders an
 * animated map frame by frame. No map tiles or API keys are involved.
 */
export async function executeGeoMapStep(
  input: GeoMapStepInput,
): Promise<GeoMapStepResult> {
  const { text, visualQuery, durationSeconds, outputMp4Path, browser, theme } = input;
  await fs.mkdir(path.dirname(outputMp4Path), { recursive: true });

  const { origin, destination, isRoute } = extractGeoEntities(text, visualQuery);
  if (!origin) {
    return { success: false, error: 'No origin location detected' };
  }

  const places = await resolvePlaces(isRoute && destination ? [origin, destination] : [origin]);
  if (places.length === 0) {
    return { success: false, error: `Could not place "${origin}"` };
  }

  try {
    await renderMapClip({
      places,
      mode: places.length >= 2 ? 'route' : 'locate',
      theme: theme ?? themeForStyle(null),
      durationSec: durationSeconds,
      outputPath: outputMp4Path,
      browser,
    });
    const first = places[0];
    return {
      success: true,
      outputPath: outputMp4Path,
      coordinates: { lat: first.lat, lng: first.lng, displayName: first.label },
    };
  } catch (err) {
    return {
      success: false,
      error: `Animated map rendering error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
