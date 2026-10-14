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

      candidates.push({
        id: `wiki_${page.pageid || Math.random()}`,
        provider: 'wikimedia',
        mediaType: isVideo ? 'video' : 'image',
        title: title.replace(/^File:/, ''),
        // Commons always returns url for an imageinfo request
        thumbnailUrl: (info.thumburl || info.url) as string,
        downloadUrl: info.url as string,
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
 * Downloads a Wikimedia candidate directly to the target file.
 */
export async function downloadWikimediaAsset(
  downloadUrl: string,
  targetPath: string,
  signal?: AbortSignal,
): Promise<string> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const res = await fetch(downloadUrl, {
    headers: { 'User-Agent': 'YT-Automation/1.0 (https://github.com)' },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Failed to download Wikimedia media from ${downloadUrl} (HTTP ${res.status})`);
  }

  const arrayBuffer = await res.arrayBuffer();
  await fs.writeFile(targetPath, Buffer.from(arrayBuffer));
  return targetPath;
}
