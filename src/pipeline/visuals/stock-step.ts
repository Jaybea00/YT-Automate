import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProviderCallContext, StockProvider, StockVideoCandidate } from '../providers/types';
import { pickBestVideoCandidate } from '../providers/stock/pixabay';

export interface StockStepResult {
  outputPath: string;
  candidate: StockVideoCandidate;
  fileUrl: string;
}

/**
 * Searches stock provider and downloads the best matching candidate into outputMp4Path.
 * Fails loudly if no candidates are found — no silent blanks.
 */
export async function executeStockStep(
  query: string,
  minDurationSeconds: number,
  outputMp4Path: string,
  stockProvider: StockProvider,
  ctx: ProviderCallContext,
): Promise<StockStepResult> {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    throw new Error('Stock search query is empty');
  }

  // 1. Initial search
  let candidates = await stockProvider.searchVideos(cleanQuery, ctx);

  // 2. Query relaxation if no results (e.g. take key nouns/first 2 words)
  if (!candidates || candidates.length === 0) {
    const words = cleanQuery
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2);
    if (words.length > 1) {
      const relaxedQuery = words.slice(0, 2).join(' ');
      candidates = await stockProvider.searchVideos(relaxedQuery, ctx);
    }
  }

  if (!candidates || candidates.length === 0) {
    throw new Error(
      `No stock video assets found for query "${cleanQuery}". Sourcing failed loudly.`,
    );
  }

  // 3. Pick best matching file: prefer resolution and duration >= minDurationSeconds
  const best = pickBestVideoCandidate(candidates, minDurationSeconds);
  if (!best || !best.fileUrl) {
    throw new Error(
      `Stock provider returned candidate hits for "${cleanQuery}" but no usable download URL.`,
    );
  }

  // 4. Download video
  await fs.mkdir(path.dirname(outputMp4Path), { recursive: true });

  if (stockProvider.downloadVideo) {
    await stockProvider.downloadVideo(best.fileUrl, outputMp4Path, ctx);
  } else {
    const res = await fetch(best.fileUrl, { signal: ctx.signal });
    if (!res.ok) {
      throw new Error(`Failed to download stock video from ${best.fileUrl} (HTTP ${res.status})`);
    }
    const arrayBuf = await res.arrayBuffer();
    await fs.writeFile(outputMp4Path, Buffer.from(arrayBuf));
  }

  return {
    outputPath: outputMp4Path,
    candidate: best.candidate,
    fileUrl: best.fileUrl,
  };
}
