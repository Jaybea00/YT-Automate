import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MediaCandidate } from '../../visuals/types';
import { MAX_MEDIA_BYTES, downloadToFile } from '../../utils/download';

export interface ArchiveOrgOptions {
  limit?: number;
  preferMediaType?: 'movies' | 'image' | 'both';
}

/**
 * Searches Internet Archive (archive.org) for public domain footage, archival newsreels, and historical imagery.
 * Free, open, zero API key required.
 */
export async function searchArchiveOrg(
  query: string,
  options: ArchiveOrgOptions = {},
): Promise<MediaCandidate[]> {
  const { limit = 5, preferMediaType = 'both' } = options;
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const mediaFilter =
    preferMediaType === 'movies'
      ? 'mediatype:movies'
      : preferMediaType === 'image'
      ? 'mediatype:image'
      : 'mediatype:(movies OR image)';

  const searchUrl = new URL('https://archive.org/advancedsearch.php');
  searchUrl.searchParams.set('q', `(${cleanQuery}) AND ${mediaFilter}`);
  searchUrl.searchParams.set('fl[]', 'identifier,title,description,mediatype,licenseurl,downloads');
  searchUrl.searchParams.set('sort[]', 'downloads desc');
  searchUrl.searchParams.set('rows', String(Math.min(15, limit * 2)));
  searchUrl.searchParams.set('page', '1');
  searchUrl.searchParams.set('output', 'json');

  try {
    const res = await fetch(searchUrl.toString(), {
      headers: {
        'User-Agent': 'YT-Automation/1.0 (https://github.com)',
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.warn(`[ArchiveOrg] Search failed with HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const docs = data.response?.docs || [];
    const candidates: MediaCandidate[] = [];

    for (const doc of docs) {
      if (!doc.identifier) continue;

      const isVideo = doc.mediatype === 'movies';
      const identifier = doc.identifier;
      const thumbUrl = `https://archive.org/services/img/${identifier}`;
      const pageUrl = `https://archive.org/details/${identifier}`;
      const title = doc.title || identifier;
      const license = doc.licenseurl || 'Public Domain / Creative Commons';

      // For downloads, we resolve file list or direct stream
      // We store a download descriptor or thumbnail as preview
      candidates.push({
        id: `archive_${identifier}`,
        provider: 'archive_org',
        mediaType: isVideo ? 'video' : 'image',
        title,
        thumbnailUrl: thumbUrl,
        downloadUrl: `https://archive.org/download/${identifier}`,
        pageUrl,
        attribution: `Internet Archive (${title})`,
        license,
        licenseProofUrl: pageUrl,
      });

      if (candidates.length >= limit) break;
    }

    return candidates;
  } catch (err) {
    console.warn(`[ArchiveOrg] Search error for "${cleanQuery}":`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Downloads the best media file from an Archive.org item identifier.
 */
export async function downloadArchiveOrgAsset(
  identifierOrUrl: string,
  targetPath: string,
  signal?: AbortSignal,
): Promise<string> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  let identifier = identifierOrUrl;
  if (identifierOrUrl.includes('archive.org/download/')) {
    const parts = identifierOrUrl.split('archive.org/download/')[1].split('/');
    identifier = parts[0];
  }

  // Fetch file metadata to get the actual mp4 / jpg file name
  const metaRes = await fetch(`https://archive.org/metadata/${identifier}/files`, { signal });
  if (!metaRes.ok) {
    throw new Error(`Failed to load archive.org metadata for ${identifier} (HTTP ${metaRes.status})`);
  }

  const metaData = await metaRes.json();
  const files: ArchiveFile[] = metaData.result || [];

  const chosenFile = chooseArchiveFile(files);
  if (!chosenFile?.name) {
    throw new Error(`No downloadable media file under the size limit in archive.org item ${identifier}`);
  }

  const directFileUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(chosenFile.name)}`;
  return downloadToFile(directFileUrl, targetPath, { signal });
}

interface ArchiveFile {
  name?: string;
  size?: string;
  format?: string;
}

/**
 * Picks the most usable file in an archive.org item: an MP4 under the download cap, preferring
 * the small web derivatives archive.org generates ("512Kb MPEG4", "h.264") over multi-hundred-MB
 * originals; otherwise the largest still image under the cap.
 */
export function chooseArchiveFile(files: ArchiveFile[]): ArchiveFile | undefined {
  const sizeOf = (f: ArchiveFile) => Number(f.size) || 0;
  const usable = (f: ArchiveFile) => !/_thumb|_sub|\.gif$/i.test(f.name ?? '') && sizeOf(f) <= MAX_MEDIA_BYTES;

  const videos = files
    .filter((f) => /\.mp4$/i.test(f.name ?? '') && usable(f) && sizeOf(f) > 200 * 1024)
    .sort((a, b) => {
      const derivative = (f: ArchiveFile) => (/512kb|h\.264|mpeg4/i.test(`${f.name} ${f.format}`) ? 0 : 1);
      return derivative(a) - derivative(b) || sizeOf(b) - sizeOf(a);
    });
  if (videos.length) return videos[0];

  return files
    .filter((f) => /\.(jpe?g|png)$/i.test(f.name ?? '') && usable(f))
    .sort((a, b) => sizeOf(b) - sizeOf(a))[0];
}
