import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MediaCandidate } from '../../visuals/types';

/**
 * Unsplash photos (https://unsplash.com/documentation): high-quality modern stills for b-roll.
 * Needs UNSPLASH_ACCESS_KEY (the app's Access Key; the Secret Key is not used). Demo apps get 50
 * requests an hour, so searches are cached and kept under an hourly budget; when it runs out,
 * Unsplash is simply skipped. API guidelines followed: photographer credit ("Photo by X on
 * Unsplash"), links carrying utm parameters, and the download endpoint triggered for every
 * photo actually used.
 */

const API = 'https://api.unsplash.com';
const UTM = 'utm_source=yt_automation&utm_medium=referral';
const HOUR_MS = 60 * 60 * 1000;
/** Requests per hour this app allows itself; Unsplash's demo limit is 50. */
const hourlyBudget = () => Number(process.env.UNSPLASH_HOURLY_BUDGET) || 45;

const recentCalls: number[] = [];
const searchCache = new Map<string, MediaCandidate[]>();
let blockedUntil = 0;

export const unsplashKey = (): string | undefined => process.env.UNSPLASH_ACCESS_KEY?.trim() || undefined;

/** Takes one request from the hourly budget, or returns false when none is left. */
function spendRequest(now = Date.now()): boolean {
  while (recentCalls.length && now - recentCalls[0] > HOUR_MS) recentCalls.shift();
  if (now < blockedUntil || recentCalls.length >= hourlyBudget()) return false;
  recentCalls.push(now);
  return true;
}

/** Notes Unsplash's own count: an exhausted limit pauses requests until the hour is up. */
function noteLimits(res: Response): void {
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  if (res.status === 403 || res.status === 429 || (Number.isFinite(remaining) && remaining <= 0)) {
    blockedUntil = Date.now() + HOUR_MS;
    console.warn('[Unsplash] Hourly request limit reached; skipping Unsplash for the next hour');
  }
}

const withUtm = (url: string) => `${url}${url.includes('?') ? '&' : '?'}${UTM}`;

interface UnsplashPhoto {
  id: string;
  width?: number;
  height?: number;
  description?: string | null;
  alt_description?: string | null;
  urls?: { raw?: string; small?: string };
  links?: { html?: string };
  user?: { name?: string; links?: { html?: string } };
}

export function toCandidate(photo: UnsplashPhoto, query: string): MediaCandidate | null {
  if (!photo.id || !photo.urls?.raw || !photo.urls.small) return null;
  const photographer = photo.user?.name?.trim() || 'an Unsplash photographer';
  return {
    id: `unsplash_${photo.id}`,
    provider: 'unsplash',
    mediaType: 'image',
    title: (photo.alt_description || photo.description || query).slice(0, 200),
    thumbnailUrl: photo.urls.small,
    // A 2560px JPEG: plenty for a slow camera move at 1080p, far smaller than the original
    downloadUrl: `${photo.urls.raw}${photo.urls.raw.includes('?') ? '&' : '?'}w=2560&fm=jpg&q=85`,
    pageUrl: photo.links?.html ? withUtm(photo.links.html) : undefined,
    width: photo.width,
    height: photo.height,
    attribution: `Photo by ${photographer} on Unsplash`,
    license: 'Unsplash License',
    licenseProofUrl: 'https://unsplash.com/license',
  };
}

/** Landscape photos for a query; [] without a key, over budget, or on any error. */
export async function searchUnsplash(query: string, options: { limit?: number } = {}): Promise<MediaCandidate[]> {
  const key = unsplashKey();
  const q = query.trim();
  if (!key || !q) return [];
  const limit = Math.min(10, options.limit ?? 6);
  const cacheKey = `${q.toLowerCase()}|${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;
  if (!spendRequest()) return [];

  try {
    const url = `${API}/search/photos?query=${encodeURIComponent(q)}&per_page=${limit}&orientation=landscape&content_filter=high`;
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' },
      signal: AbortSignal.timeout(15000),
    });
    noteLimits(res);
    if (!res.ok) {
      console.warn(`[Unsplash] Search failed with HTTP ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { results?: UnsplashPhoto[] };
    const found = (data.results ?? []).map((p) => toCandidate(p, q)).filter((c): c is MediaCandidate => Boolean(c));
    searchCache.set(cacheKey, found);
    return found;
  } catch (err) {
    console.warn(`[Unsplash] Search error for "${q}":`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Downloads an Unsplash photo, then reports the download to Unsplash, as the API guidelines
 * require for every photo an app uses (best effort: a failed report never fails the shot).
 */
export async function downloadUnsplashAsset(candidate: Pick<MediaCandidate, 'id' | 'downloadUrl'>, targetPath: string, signal?: AbortSignal): Promise<string> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const res = await fetch(candidate.downloadUrl, { signal });
  if (!res.ok) throw new Error(`Failed to download Unsplash photo (HTTP ${res.status})`);
  await fs.writeFile(targetPath, Buffer.from(await res.arrayBuffer()));

  const key = unsplashKey();
  const photoId = String(candidate.id).replace(/^unsplash_/, '');
  if (key && photoId && spendRequest()) {
    await fetch(`${API}/photos/${encodeURIComponent(photoId)}/download`, {
      headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' },
      signal: AbortSignal.timeout(10000),
    })
      .then(noteLimits)
      .catch(() => {});
  }
  return targetPath;
}

/** For tests: forget the budget, block and cache. */
export function resetUnsplashState(): void {
  recentCalls.length = 0;
  searchCache.clear();
  blockedUntil = 0;
}
