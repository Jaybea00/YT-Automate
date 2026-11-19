import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from '../utils/atomic-write';

/**
 * Fresh footage across the channel: which footage sources each video used, so later videos
 * prefer clips the channel hasn't shown yet. A channel that reuses the same twenty stock clips
 * looks mass-produced, to viewers and to YouTube's reused-content review.
 */

export interface FootageUsage {
  version: 1;
  /** Source key (page URL or download URL) → the videos that used it. */
  sources: Record<string, { videos: string[]; lastUsed: string }>;
}

/** Score taken off for each other video that already used a candidate (at most twice). */
export const REUSE_PENALTY = 1.5;
const MAX_PENALTY_VIDEOS = 2;

export const usagePath = () => process.env.FOOTAGE_USAGE_FILE || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'settings', 'footage-usage.json');

export async function loadFootageUsage(file = usagePath()): Promise<FootageUsage> {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf-8')) as FootageUsage;
    return data.version === 1 && data.sources ? data : { version: 1, sources: {} };
  } catch {
    return { version: 1, sources: {} };
  }
}

/** How many videos other than this one have used a source. */
export function usedElsewhere(usage: FootageUsage, key: string, videoId?: string | null): number {
  const videos = usage.sources[key]?.videos ?? [];
  return videos.filter((v) => v !== videoId).length;
}

/** The score after the reuse penalty (never below 0). */
export function freshnessAdjusted(score: number, otherVideos: number): number {
  return Math.max(0, score - REUSE_PENALTY * Math.min(MAX_PENALTY_VIDEOS, otherVideos));
}

/** Records the sources a video used (replacing what was recorded for it before). */
export function withVideoSources(usage: FootageUsage, videoId: string, keys: Iterable<string>, now = new Date().toISOString()): FootageUsage {
  const next: FootageUsage = { version: 1, sources: {} };
  for (const [k, v] of Object.entries(usage.sources)) {
    const videos = v.videos.filter((x) => x !== videoId);
    if (videos.length) next.sources[k] = { ...v, videos };
  }
  for (const key of keys) {
    if (!key || key.startsWith('library:') || key.startsWith('moment:')) continue; // the creator's own footage is meant to be reused
    const entry = (next.sources[key] ??= { videos: [], lastUsed: now });
    entry.videos.push(videoId);
    entry.lastUsed = now;
  }
  return next;
}

const lock = globalThis as unknown as { __usageLock?: Promise<unknown> };

export async function recordFootageUse(videoId: string, keys: Iterable<string>, file = usagePath()): Promise<void> {
  const list = [...keys];
  const run = (lock.__usageLock ?? Promise.resolve()).catch(() => {}).then(async () => {
    const next = withVideoSources(await loadFootageUsage(file), videoId, list);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(next));
  });
  lock.__usageLock = run;
  return run;
}
