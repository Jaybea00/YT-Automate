import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { geocodeLocation, type GeoCoordinates } from './geocoder';
import { convertWebmToMp4 } from '../utils/ffmpeg';

export interface GeoMapStepInput {
  text: string;
  visualQuery?: string;
  durationSeconds: number;
  outputMp4Path: string;
  tempDir: string;
  browser?: Browser;
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
 * Generates an animated 1080p Leaflet map HTML document.
 */
export function buildAnimatedMapHtml(options: {
  origin: GeoCoordinates;
  dest?: GeoCoordinates | null;
  isRoute: boolean;
  label?: string;
  durationSeconds: number;
}): string {
  const { origin, dest, isRoute, label, durationSeconds } = options;
  const startZoom = isRoute ? 6 : 8;
  const endZoom = isRoute ? 9 : 13;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Map</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body, html, #map {
      margin: 0;
      padding: 0;
      width: 1920px;
      height: 1080px;
      background: #09090b;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .pulse-ring {
      width: 40px;
      height: 40px;
      border: 3px solid #6366f1;
      border-radius: 50%;
      position: absolute;
      left: -20px;
      top: -20px;
      animation: pulse 1.8s infinite ease-out;
    }
    .pulse-dot {
      width: 14px;
      height: 14px;
      background: #818cf8;
      border: 3px solid #ffffff;
      border-radius: 50%;
      position: absolute;
      left: -7px;
      top: -7px;
      box-shadow: 0 0 15px #6366f1;
    }
    @keyframes pulse {
      0% { transform: scale(0.4); opacity: 1; }
      100% { transform: scale(2.4); opacity: 0; }
    }
    .map-badge {
      position: absolute;
      bottom: 40px;
      left: 40px;
      z-index: 1000;
      background: rgba(9, 9, 11, 0.85);
      border: 1px solid rgba(99, 102, 241, 0.4);
      padding: 12px 24px;
      border-radius: 12px;
      color: #ffffff;
      font-size: 22px;
      font-weight: 700;
      backdrop-filter: blur(8px);
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    }
  </style>
</head>
<body>
  <div id="map"></div>
  ${label ? `<div class="map-badge">📍 ${label}</div>` : ''}

  <script>
    const map = L.map('map', {
      zoomControl: false,
      attributionControl: false
    }).setView([${origin.lat}, ${origin.lng}], ${startZoom});

    // Dark Matter tiles for broadcast documentary aesthetic
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd'
    }).addTo(map);

    // Custom glowing pulsing marker
    const pulseIcon = L.divIcon({
      className: '',
      html: '<div class="pulse-ring"></div><div class="pulse-dot"></div>'
    });

    L.marker([${origin.lat}, ${origin.lng}], { icon: pulseIcon }).addTo(map);

    ${dest ? `
      L.marker([${dest.lat}, ${dest.lng}], { icon: pulseIcon }).addTo(map);

      // Glowing route line
      const routeLine = L.polyline([
        [${origin.lat}, ${origin.lng}],
        [${dest.lat}, ${dest.lng}]
      ], {
        color: '#818cf8',
        weight: 5,
        opacity: 0.9,
        dashArray: '10, 10'
      }).addTo(map);
    ` : ''}

    // Trigger smooth camera animation over duration
    setTimeout(() => {
      ${isRoute && dest ? `
        map.flyToBounds([
          [${origin.lat}, ${origin.lng}],
          [${dest.lat}, ${dest.lng}]
        ], {
          padding: [150, 150],
          duration: ${durationSeconds},
          easeLinearity: 0.25
        });
      ` : `
        map.flyTo([${origin.lat}, ${origin.lng}], ${endZoom}, {
          duration: ${durationSeconds},
          easeLinearity: 0.2
        });
      `}
    }, 400);
  </script>
</body>
</html>`;
}

/**
 * Executes the full animated map generation step:
 * Extracts geo entities -> geocodes -> renders in Playwright -> records to MP4.
 */
export async function executeGeoMapStep(
  input: GeoMapStepInput,
): Promise<GeoMapStepResult> {
  const { text, visualQuery, durationSeconds, outputMp4Path, tempDir, browser: existingBrowser } = input;

  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(path.dirname(outputMp4Path), { recursive: true });

  // 1. Extract place names
  const { origin, destination, isRoute, label } = extractGeoEntities(text, visualQuery);
  if (!origin) {
    return { success: false, error: 'No origin location detected' };
  }

  // 2. Geocode origin and destination
  const originCoords = await geocodeLocation(origin);
  if (!originCoords) {
    return { success: false, error: `Could not geocode origin "${origin}"` };
  }

  const destCoords = destination ? await geocodeLocation(destination) : null;

  // 3. Build HTML file
  const htmlContent = buildAnimatedMapHtml({
    origin: originCoords,
    dest: destCoords,
    isRoute,
    label: label || originCoords.displayName.split(',')[0],
    durationSeconds,
  });

  const htmlPath = path.join(tempDir, 'map_animation.html');
  await fs.writeFile(htmlPath, htmlContent, 'utf-8');

  // 4. Record with Playwright
  let browser = existingBrowser;
  let shouldCloseBrowser = false;

  try {
    if (!browser) {
      browser = await chromium.launch({ headless: true });
      shouldCloseBrowser = true;
    }

    const recDir = path.join(tempDir, 'rec');
    await fs.mkdir(recDir, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      recordVideo: {
        dir: recDir,
        size: { width: 1920, height: 1080 },
      },
    });

    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 25000 });

    // Wait for the full animation duration
    const waitMs = Math.max(1000, durationSeconds * 1000);
    await page.waitForTimeout(waitMs);

    await page.close();
    await context.close();

    // 5. Find recorded webm file
    const recFiles = await fs.readdir(recDir);
    const webmFile = recFiles.find((f) => f.endsWith('.webm'));
    if (!webmFile) {
      return { success: false, error: 'Playwright did not output a recorded video file' };
    }

    const rawWebmPath = path.join(recDir, webmFile);

    // 6. Convert WebM to MP4
    await convertWebmToMp4(rawWebmPath, outputMp4Path, durationSeconds);

    return {
      success: true,
      outputPath: outputMp4Path,
      coordinates: originCoords,
    };
  } catch (err) {
    return {
      success: false,
      error: `Animated map rendering error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (shouldCloseBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}
