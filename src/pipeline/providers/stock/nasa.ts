import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MediaCandidate } from '../../visuals/types';

export interface NasaOptions {
  limit?: number;
}

/**
 * Searches the NASA Image and Video Library for public domain space and scientific media.
 * Free, open, zero API key required.
 */
export async function searchNasa(
  query: string,
  options: NasaOptions = {},
): Promise<MediaCandidate[]> {
  const { limit = 5 } = options;
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const url = new URL('https://images-api.nasa.gov/search');
  url.searchParams.set('q', cleanQuery);
  url.searchParams.set('media_type', 'image,video');

  try {
    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'YT-Automation/1.0 (https://github.com)',
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.warn(`[NASA] Search failed with HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const items = data.collection?.items || [];
    const candidates: MediaCandidate[] = [];

    for (const item of items) {
      const datum = item.data?.[0];
      if (!datum) continue;

      const nasaId = datum.nasa_id || Math.random().toString();
      const title = datum.title || 'NASA Media';
      const isVideo = datum.media_type === 'video';
      const thumbUrl = item.links?.[0]?.href || '';
      const collectionUrl = item.href; // Points to collection.json containing direct assets

      candidates.push({
        id: `nasa_${nasaId}`,
        provider: 'nasa',
        mediaType: isVideo ? 'video' : 'image',
        title,
        thumbnailUrl: thumbUrl,
        downloadUrl: collectionUrl, // will resolve asset via collection.json on download
        pageUrl: `https://images.nasa.gov/details/${encodeURIComponent(nasaId)}`,
        attribution: 'NASA / Public Domain',
        license: 'Public Domain',
        licenseProofUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
      });

      if (candidates.length >= limit) break;
    }

    return candidates;
  } catch (err) {
    console.warn(`[NASA] Search error for "${cleanQuery}":`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Downloads a NASA asset (fetches collection.json to get direct high-res asset link).
 */
export async function downloadNasaAsset(
  collectionUrl: string,
  targetPath: string,
  signal?: AbortSignal,
): Promise<string> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  let directUrl = collectionUrl;

  if (collectionUrl.endsWith('collection.json') || collectionUrl.includes('images-assets.nasa.gov')) {
    const collRes = await fetch(collectionUrl, { signal });
    if (collRes.ok) {
      const assets: string[] = await collRes.json();
      // Pick best resolution
      const mp4 = assets.find((u) => u.toLowerCase().endsWith('~orig.mp4') || u.toLowerCase().endsWith('~large.mp4') || u.toLowerCase().endsWith('.mp4'));
      const origJpg = assets.find((u) => u.toLowerCase().endsWith('~orig.jpg') || u.toLowerCase().endsWith('~large.jpg') || u.toLowerCase().endsWith('~medium.jpg'));
      directUrl = mp4 || origJpg || assets[0] || collectionUrl;
    }
  }

  const res = await fetch(directUrl, { signal });
  if (!res.ok) {
    throw new Error(`Failed to download NASA media from ${directUrl} (HTTP ${res.status})`);
  }

  const arrayBuffer = await res.arrayBuffer();
  await fs.writeFile(targetPath, Buffer.from(arrayBuffer));
  return targetPath;
}
