import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProviderCallContext, StockProvider } from '../providers/types';
import type { MediaCandidate } from './types';
import { searchWikimediaCommons, downloadWikimediaAsset } from '../providers/stock/wikimedia';
import { searchArchiveOrg, downloadArchiveOrgAsset } from '../providers/stock/archive-org';
import { searchNasa, downloadNasaAsset } from '../providers/stock/nasa';
import { classifyVisualIntent, type VisualIntent } from './intent-classifier';
import { isUnusableLicense } from '../utils/media-upload';

export interface AggregateMediaOptions {
  query: string;
  text: string;
  explicitType?: string;
  targetDurationSeconds?: number;
  stockProvider?: StockProvider;
  stockCtx?: ProviderCallContext;
  limit?: number;
}

/**
 * Gathers 3–5 candidate media assets from open archives, Wikimedia, NASA, and stock libraries.
 */
export async function aggregateMediaCandidates(
  options: AggregateMediaOptions,
): Promise<{ candidates: MediaCandidate[]; intent: VisualIntent }> {
  const {
    query,
    text,
    explicitType,
    stockProvider,
    stockCtx,
    limit = 4,
  } = options;

  const { intent, keywords } = classifyVisualIntent(text, query, explicitType);
  const candidates: MediaCandidate[] = [];

  // Helper to dedupe by title or id; NonCommercial / NoDerivatives media can't be used on a
  // monetised channel with the cropping and zooming the pipeline applies
  const addCandidates = (items: MediaCandidate[]) => {
    for (const item of items) {
      if (isUnusableLicense(item.license)) continue;
      if (!candidates.some((c) => c.title === item.title || c.id === item.id)) {
        candidates.push(item);
      }
      if (candidates.length >= limit) break;
    }
  };

  // 1. Primary Source based on classified intent
  if (intent === 'nasa_space') {
    const nasaItems = await searchNasa(keywords, { limit });
    addCandidates(nasaItems);
  } else if (intent === 'archive') {
    const wikiItems = await searchWikimediaCommons(keywords, { limit });
    addCandidates(wikiItems);
    if (candidates.length < limit) {
      const archiveItems = await searchArchiveOrg(keywords, { limit: limit - candidates.length });
      addCandidates(archiveItems);
    }
  }

  // 2. Stock Provider (Pixabay / Pexels) for stock intent or as high-quality supplement
  if (candidates.length < limit && stockProvider && stockCtx?.apiKey) {
    try {
      const stockHits = await stockProvider.searchVideos(keywords, stockCtx);
      for (const hit of stockHits || []) {
        const file = hit.files?.[0] || { url: hit.url, width: hit.width, height: hit.height };
        candidates.push({
          id: `stock_${hit.id}`,
          provider: 'pixabay',
          mediaType: 'video',
          title: hit.tags || keywords,
          thumbnailUrl: hit.thumbnailUrl ?? '',
          downloadUrl: file.url,
          pageUrl: hit.pageUrl,
          duration: hit.duration,
          width: hit.width,
          height: hit.height,
          attribution: hit.attribution || 'Pixabay Contributor',
          license: 'royalty_free',
          licenseProofUrl: 'https://pixabay.com/service/license-summary/',
        });
        if (candidates.length >= limit) break;
      }
    } catch (err) {
      console.warn(`[MediaAggregator] Stock search error for "${keywords}":`, err instanceof Error ? err.message : String(err));
    }
  }

  // 3. Fallback: If still under limit, query Wikimedia Commons (free, zero keys, vast coverage)
  if (candidates.length < limit) {
    const wikiFallback = await searchWikimediaCommons(keywords, { limit: limit - candidates.length });
    addCandidates(wikiFallback);
  }

  // 4. Ultimate Safety Net: If zero candidates were found across stock and archives, generate an AI visual candidate
  if (candidates.length === 0 && (keywords || query || text)) {
    try {
      const { generateAiVisualCandidate } = await import('./ai-image-step');
      const aiCandidate = await generateAiVisualCandidate({
        prompt: keywords || query || text,
        text,
      });
      candidates.push(aiCandidate);
    } catch (err) {
      console.warn(`[MediaAggregator] AI visual fallback error:`, err);
    }
  }

  return { candidates, intent };
}

/**
 * Downloads a candidate to the local filesystem regardless of provider.
 */
export async function downloadCandidateAsset(
  candidate: MediaCandidate,
  targetPath: string,
  ctx?: ProviderCallContext,
  stockProvider?: StockProvider,
): Promise<string> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  // The creator's own file, already on disk
  if (candidate.provider === 'uploaded' && !/^https?:/i.test(candidate.downloadUrl)) {
    await fs.copyFile(candidate.downloadUrl, targetPath);
    return targetPath;
  }

  if (candidate.provider === 'pollinations' || candidate.provider === 'openai') {
    const { downloadAndSaveAiImage } = await import('./ai-image-step');
    return downloadAndSaveAiImage(candidate, targetPath);
  }

  if (candidate.provider === 'fal' || candidate.provider === 'veo') {
    const { downloadAndSaveAiVideo } = await import('./ai-video-step');
    return downloadAndSaveAiVideo(candidate.downloadUrl, targetPath);
  }

  if (candidate.provider === 'wikimedia') {
    return downloadWikimediaAsset(candidate.downloadUrl, targetPath, ctx?.signal);
  }

  if (candidate.provider === 'archive_org') {
    return downloadArchiveOrgAsset(candidate.downloadUrl, targetPath, ctx?.signal);
  }

  if (candidate.provider === 'unsplash') {
    const { downloadUnsplashAsset } = await import('../providers/stock/unsplash');
    return downloadUnsplashAsset(candidate, targetPath, ctx?.signal);
  }

  if (candidate.provider === 'nasa') {
    return downloadNasaAsset(candidate.downloadUrl, targetPath, ctx?.signal);
  }

  if (candidate.provider === 'pixabay' || candidate.provider === 'pexels') {
    if (stockProvider?.downloadVideo) {
      return stockProvider.downloadVideo(candidate.downloadUrl, targetPath, ctx);
    }
  }

  // Default / Stock direct HTTP download
  const res = await fetch(candidate.downloadUrl, { signal: ctx?.signal });
  if (!res.ok) {
    throw new Error(`Failed to download media candidate from ${candidate.downloadUrl} (HTTP ${res.status})`);
  }

  const arrayBuffer = await res.arrayBuffer();
  await fs.writeFile(targetPath, Buffer.from(arrayBuffer));
  return targetPath;
}
