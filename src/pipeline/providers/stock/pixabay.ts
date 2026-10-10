import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type {
  ProviderCallContext,
  StockProvider,
  StockVideoCandidate,
  StockVideoFile,
} from '../types';

export const PixabayVideoSizeSchema = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
  size: z.number().optional(),
  thumbnail: z.string().optional(),
});

export const PixabayHitSchema = z.object({
  id: z.number(),
  pageURL: z.string().optional(),
  type: z.string().optional(),
  tags: z.string().optional(),
  duration: z.number(),
  videos: z.object({
    large: PixabayVideoSizeSchema.optional(),
    medium: PixabayVideoSizeSchema.optional(),
    small: PixabayVideoSizeSchema.optional(),
    tiny: PixabayVideoSizeSchema.optional(),
  }),
  user: z.string().optional(),
});

export const PixabayResponseSchema = z.object({
  total: z.number().optional(),
  totalHits: z.number().optional(),
  hits: z.array(PixabayHitSchema),
});

export type PixabayVideoHit = z.infer<typeof PixabayHitSchema>;
export type PixabayResponse = z.infer<typeof PixabayResponseSchema>;

/**
 * Truncates and sanitizes a query string for Pixabay API.
 * Pixabay's API rejects 'q' exceeding 100 characters.
 * Normalizes extra whitespace, caps at 100 characters, breaking at a word boundary
 * rather than mid-word, and strips trailing punctuation left by truncation.
 */
export function sanitizePixabayQuery(query: string, maxLen: number = 100): string {
  if (!query) return '';
  const cleaned = query.trim().replace(/\s+/g, ' ');
  if (cleaned.length <= maxLen) {
    return cleaned;
  }
  const truncated = cleaned.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  const result = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return result.replace(/[,;:\-–—\s]+$/, '').trim();
}

export class PixabayStockProvider implements StockProvider {
  readonly kind = 'stock' as const;
  readonly id: string;
  readonly requiresApiKey = true;

  constructor(id: string = 'pixabay') {
    this.id = id;
  }

  async searchVideos(
    query: string,
    ctx: ProviderCallContext,
  ): Promise<StockVideoCandidate[]> {
    const baseUrl = ctx.baseUrl || 'https://pixabay.com/api/videos/';
    const cleanQuery = sanitizePixabayQuery(query);

    if (!cleanQuery) {
      throw new ProviderError('Pixabay stock search query is empty', {
        code: 'invalid_request',
      });
    }

    if (!ctx.apiKey) {
      throw new ProviderError('Pixabay API key is required to search stock videos', {
        code: 'auth',
      });
    }

    const url = new URL(baseUrl);
    url.searchParams.set('key', ctx.apiKey);
    url.searchParams.set('q', cleanQuery);
    url.searchParams.set('video_type', 'all');
    url.searchParams.set('orientation', 'horizontal'); // Landscape orientation
    url.searchParams.set('safesearch', 'true');
    url.searchParams.set('per_page', '30');

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: ctx.signal,
      });

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // ignore
        }
        throw mapHttpOrSdkError(
          {
            status: response.status,
            message: `Pixabay API request failed: ${errorBody || response.statusText}`,
            headers: response.headers,
          },
          'Pixabay stock video search failed',
        );
      }

      const rawData: unknown = await response.json();
      const parseResult = PixabayResponseSchema.safeParse(rawData);

      if (!parseResult.success) {
        throw new ProviderError(
          `Pixabay search response did not match expected schema: ${parseResult.error.message}`,
          { code: 'invalid_response', cause: parseResult.error },
        );
      }

      const hits = parseResult.data.hits;

      return hits.map((hit) => {
        const files: StockVideoFile[] = [];
        const qualities: Array<keyof PixabayVideoHit['videos']> = ['large', 'medium', 'small', 'tiny'];

        for (const q of qualities) {
          const v = hit.videos[q];
          if (v && v.url) {
            files.push({
              url: v.url,
              width: v.width,
              height: v.height,
              size: v.size,
              quality: q,
            });
          }
        }

        // Pick best default file (largest resolution)
        const bestFile = files[0] || {
          url: '',
          width: 1920,
          height: 1080,
        };

        return {
          id: hit.id,
          url: bestFile.url,
          width: bestFile.width,
          height: bestFile.height,
          duration: hit.duration,
          pageUrl: hit.pageURL,
          attribution: hit.user ? `Video by ${hit.user} on Pixabay` : 'Pixabay',
          tags: hit.tags,
          files,
        };
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw mapHttpOrSdkError(error, 'Pixabay stock video search failed');
    }
  }

  async downloadVideo(
    url: string,
    targetPath: string,
    ctx?: ProviderCallContext,
  ): Promise<string> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: ctx?.signal,
      });

      if (!response.ok) {
        throw new Error(`Failed to download stock video from ${url} (HTTP ${response.status})`);
      }

      const buffer = await response.arrayBuffer();
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, Buffer.from(buffer));
      return targetPath;
    } catch (error) {
      throw mapHttpOrSdkError(error, 'Stock video download failed');
    }
  }
}

/**
 * Picks the best matching video file from candidates:
 * 1. Prefer duration >= minDurationSeconds so it doesn't need looping if avoidable
 * 2. Prefer largest available resolution (large 1080p > medium 720p > ...)
 * 3. Falls back to longest available candidate if none meet minDuration
 */
export function pickBestVideoCandidate(
  candidates: StockVideoCandidate[],
  minDurationSeconds: number = 0,
): { candidate: StockVideoCandidate; fileUrl: string; width: number; height: number } | null {
  if (!candidates || candidates.length === 0) {
    return null;
  }

  // Filter candidates with duration >= minDurationSeconds
  const meetingDuration = minDurationSeconds > 0
    ? candidates.filter((c) => c.duration >= minDurationSeconds)
    : candidates;

  const pool = meetingDuration.length > 0 ? meetingDuration : candidates;

  // Score each candidate by resolution (width * height) and duration
  const scored = pool.map((c) => {
    // Pick the highest resolution file for this candidate
    const sortedFiles = [...(c.files || [])].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    const bestFile = sortedFiles[0] || {
      url: c.url,
      width: c.width,
      height: c.height,
    };

    const resolutionScore = bestFile.width * bestFile.height;
    // Secondary score: duration bonus if meets requirement
    const durationScore = c.duration >= minDurationSeconds ? 10000 : c.duration;

    return {
      candidate: c,
      bestFile,
      score: resolutionScore + durationScore,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  return {
    candidate: best.candidate,
    fileUrl: best.bestFile.url,
    width: best.bestFile.width,
    height: best.bestFile.height,
  };
}

export const pixabayStock = new PixabayStockProvider('pixabay');
