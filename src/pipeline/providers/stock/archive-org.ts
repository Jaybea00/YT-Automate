import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MediaCandidate } from '../../visuals/types';

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
  const files: any[] = metaData.result || [];

  // Find preferred file: 512Kb MPEG4 or h.264 mp4 or high-res jpg
  const mp4 = files.find(
    (f) =>
      f.name?.toLowerCase().endsWith('.mp4') &&
      !f.name?.toLowerCase().includes('_thumb') &&
      !f.name?.toLowerCase().includes('_sub'),
  );
  const jpg = files.find(
    (f) =>
      (f.name?.toLowerCase().endsWith('.jpg') || f.name?.toLowerCase().endsWith('.png')) &&
      !f.name?.toLowerCase().includes('_thumb'),
  );

  const chosenFile = mp4 || jpg || files[0];
  if (!chosenFile?.name) {
    throw new Error(`No downloadable media file found in archive.org item ${identifier}`);
  }

  const directFileUrl = `https://archive.org/download/${identifier}/${chosenFile.name}`;
  const fileRes = await fetch(directFileUrl, { signal });
  if (!fileRes.ok) {
    throw new Error(`Failed to download from ${directFileUrl} (HTTP ${fileRes.status})`);
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  await fs.writeFile(targetPath, Buffer.from(arrayBuffer));
  return targetPath;
}
