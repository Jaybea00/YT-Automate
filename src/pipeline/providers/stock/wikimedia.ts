import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MediaCandidate } from '../../visuals/types';

/** The parts of a Commons API page (with imageinfo and extmetadata) this module reads. */
interface CommonsPage {
  pageid?: number;
  title?: string;
  imageinfo?: Array<{
    mime?: string;
    width?: number;
    height?: number;
    url?: string;
    thumburl?: string;
    descriptionurl?: string;
    extmetadata?: Record<string, { value?: string } | undefined>;
  }>;
}

/** Image formats ffmpeg and the page renderer read directly. Others (mostly TIFF scans) use Commons' JPEG rendering. */
const DIRECT_IMAGE_MIME = /^image\/(jpeg|png|webp|gif)$/;
/** Width of the JPEG rendering fetched for TIFF and other formats that aren't read directly. */
const RENDERED_IMAGE_WIDTH = 1920;
/** The only thumbnail widths Commons serves; any other width gets HTTP 400. */
export const COMMONS_THUMB_WIDTHS = [120, 250, 330, 500, 960, 1280, 1920, 3840] as const;

/** The largest standard thumbnail width that doesn't exceed `max`, and at least 960. */
export function commonsThumbWidth(max: number): number {
  let width = 960;
  for (const w of COMMONS_THUMB_WIDTHS) if (w <= max && w > width) width = w;
  return width;
}

/**
 * Changes the width in a Commons thumbnail URL. Thumbnails end in "/800px-Name.jpg", or for TIFF
 * and other paged formats "/lossy-page1-800px-Name.tif.jpg".
 */
export function resizeCommonsThumb(thumbUrl: string, width: number): string {
  return thumbUrl.replace(/([/-])\d+px-([^/]+)$/, `$1${width}px-$2`);
}

export interface WikimediaOptions {
  limit?: number;
  minWidth?: number;
  userAgent?: string;
}

/**
 * Searches Wikimedia Commons for authentic historical, educational, and public domain media.
 * Free, open, zero API key required.
 */
export async function searchWikimediaCommons(
  query: string,
  options: WikimediaOptions = {},
): Promise<MediaCandidate[]> {
  const { limit = 5, minWidth = 1000, userAgent = 'YT-Automation/1.0 (https://github.com)' } = options;
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrsearch', cleanQuery);
  url.searchParams.set('gsrnamespace', '6'); // File namespace
  url.searchParams.set('gsrlimit', String(Math.min(20, limit * 3)));
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|size|mime|extmetadata');
  url.searchParams.set('iiurlwidth', '800'); // thumbnail size
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  try {
    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.warn(`[Wikimedia] Search failed with HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const pages = Object.values(data.query?.pages || {}) as CommonsPage[];

    const candidates: MediaCandidate[] = [];

    for (const page of pages) {
      if (!page || !page.imageinfo || !page.imageinfo[0]) continue;
      const info = page.imageinfo[0];
      const mime = (info.mime || '').toLowerCase();

      // Exclude vector graphics, icons, audio, pdfs, and tiny icons
      if (
        mime.includes('svg') ||
        mime.includes('audio') ||
        mime.includes('pdf') ||
        mime.includes('djvu')
      ) {
        continue;
      }

      // Check title for unwanted noisy assets
      const title = String(page.title || '');
      const lowerTitle = title.toLowerCase();
      if (
        lowerTitle.includes('flag of') ||
        lowerTitle.includes('coat of arms') ||
        lowerTitle.includes('icon') ||
        lowerTitle.includes('logo') ||
        lowerTitle.includes('signature')
      ) {
        continue;
      }

      const width = Number(info.width) || 0;
      const height = Number(info.height) || 0;

      // Filter out low resolution images
      if (width > 0 && width < minWidth && height < minWidth) {
        continue;
      }

      const isVideo = mime.startsWith('video/') || lowerTitle.endsWith('.mp4') || lowerTitle.endsWith('.webm');
      const extmeta = info.extmetadata || {};
      const license = extmeta.LicenseShortName?.value || extmeta.UsageTerms?.value || 'Public domain / CC';
      const author = extmeta.Artist?.value?.replace(/<[^>]*>?/gm, '').trim() || 'Wikimedia Commons contributor';

      // ffmpeg can't decode many TIFF scans (they come out 0x0), so fetch Commons' JPEG rendering instead
      let downloadUrl = info.url as string;
      if (!isVideo && !DIRECT_IMAGE_MIME.test(mime) && info.thumburl && /\/thumb\//.test(info.thumburl)) {
        downloadUrl = resizeCommonsThumb(info.thumburl, commonsThumbWidth(width > 0 ? Math.min(width, RENDERED_IMAGE_WIDTH) : RENDERED_IMAGE_WIDTH));
      }

      candidates.push({
        id: `wiki_${page.pageid || Math.random()}`,
        provider: 'wikimedia',
        mediaType: isVideo ? 'video' : 'image',
        title: title.replace(/^File:/, ''),
        // Commons always returns url for an imageinfo request
        thumbnailUrl: (info.thumburl || info.url) as string,
        downloadUrl,
        pageUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
        width,
        height,
        attribution: `${author} / Wikimedia Commons`,
        license,
        licenseProofUrl: 'https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia',
      });

      if (candidates.length >= limit) break;
    }

    return candidates;
  } catch (err) {
    console.warn(`[Wikimedia] Search error for query "${cleanQuery}":`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Fetches a file from Wikimedia's media servers. They briefly answer 429 when many files are
 * requested in a row, so a 429 is retried once after the wait they ask for (capped at 10 s).
 */
export async function fetchCommonsFile(url: string, signal?: AbortSignal): Promise<Response> {
  const get = () => fetch(url, { headers: { 'User-Agent': 'YT-Automation/1.0 (https://github.com)' }, signal });
  const res = await get();
  if (res.status !== 429) return res;
  const retryAfter = Number(res.headers.get('retry-after'));
  const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 3000;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return get();
}

/**
 * Downloads a Wikimedia candidate directly to the target file.
 */
export async function downloadWikimediaAsset(
  downloadUrl: string,
  targetPath: string,
  signal?: AbortSignal,
): Promise<string> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const res = await fetchCommonsFile(downloadUrl, signal);

  if (!res.ok) {
    throw new Error(`Failed to download Wikimedia media from ${downloadUrl} (HTTP ${res.status})`);
  }

  const arrayBuffer = await res.arrayBuffer();
  await fs.writeFile(targetPath, Buffer.from(arrayBuffer));
  return targetPath;
}
