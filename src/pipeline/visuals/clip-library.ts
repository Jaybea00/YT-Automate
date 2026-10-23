import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '../providers/registry';
import type { LLMProvider, LlmImage } from '../providers/types';
import { getFfmpegPath } from '../utils/ffmpeg';
import { probeMediaFile, sniffMediaType } from '../utils/media-upload';
import type { MediaCandidate } from './types';

const execFileAsync = promisify(execFile);

/**
 * The creator's own clip library: footage and photos added once (their own, or licensed), each
 * described by looking at it so it can be found by subject. The footage picker searches it for
 * every video, alongside the archives and stock, and the relevance check judges it the same way.
 */

export interface LibraryClip {
  id: string;
  name: string;
  /** The media file. */
  path: string;
  /** A frame from the middle, for previews and the relevance check. */
  thumbPath: string;
  isVideo: boolean;
  durationSec: number;
  description: string;
  tags: string[];
  license: string;
  attribution: string | null;
  addedAt: string;
}

/** storage/library, or CLIP_LIBRARY_DIR (tests point it at a temporary folder). */
export const libraryDir = () => process.env.CLIP_LIBRARY_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'library');
const indexPath = (dir: string) => path.join(/* turbopackIgnore: true */ dir, 'index.json');

export async function listLibrary(): Promise<LibraryClip[]> {
  const dir = libraryDir();
  try {
    const list = JSON.parse(await fs.readFile(indexPath(dir), 'utf-8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveIndex(list: LibraryClip[]): Promise<void> {
  const dir = libraryDir();
  await fs.mkdir(dir, { recursive: true });
  // Written to a temporary file first, so a crash mid-write can't lose the library
  const tmp = `${indexPath(dir)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(list, null, 2), 'utf-8');
  await fs.rename(tmp, indexPath(dir));
}

const DescribeSchema = z.object({ description: z.string(), tags: z.array(z.string()) });

async function frameAt(file: string, atSec: number | null, out: string): Promise<void> {
  await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', ...(atSec !== null ? ['-ss', String(atSec)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', out]);
}

/** What the clip shows, in a sentence and tags, from frames across it. Falls back to the file name. */
async function describe(supabase: SupabaseClient | null, name: string, frames: string[]): Promise<{ description: string; tags: string[] }> {
  const fallback = { description: name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '), tags: [] as string[] };
  if (!supabase) return fallback;
  try {
    const { provider, ctx } = await resolveForStage<LLMProvider>('script', supabase);
    if (!provider.supportsVision) return fallback;
    const images: LlmImage[] = await Promise.all(frames.map(async (f) => ({ mimeType: 'image/jpeg', data: (await fs.readFile(f)).toString('base64') })));
    const { data } = await provider.generateJson(
      {
        prompt: `These frames come from one clip ("${name}") in a documentary maker's footage library. Describe what it shows in one plain sentence (subjects, place, action, era if clear), then give 6-12 search tags (single words or short phrases a person would search for). Return {"description": "...", "tags": [...]}.`,
        schema: DescribeSchema,
        images,
      },
      ctx,
    );
    return { description: data.description.trim() || fallback.description, tags: data.tags.map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 12) };
  } catch (err) {
    console.warn(`[Library] Could not describe ${name}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    return fallback;
  }
}

/** Adds a file to the library: saved, a thumbnail taken, described by what it shows. */
export async function addToLibrary(
  supabase: SupabaseClient | null,
  file: { name: string; buffer: Buffer; license: string; attribution?: string | null },
): Promise<LibraryClip> {
  const dir = libraryDir();
  const sniffed = sniffMediaType(file.buffer);
  if (!sniffed) throw new Error(`${file.name}: unsupported file (use mp4, mov, webm, jpg, png or webp)`);
  const id = randomUUID();
  await fs.mkdir(dir, { recursive: true });
  const mediaPath = path.join(/* turbopackIgnore: true */ dir, `${id}.${sniffed.ext}`);
  await fs.writeFile(mediaPath, file.buffer);
  try {
    const info = await probeMediaFile(mediaPath);
    const durationSec = info.durationMs / 1000;
    const thumbPath = path.join(/* turbopackIgnore: true */ dir, `${id}.thumb.jpg`);
    await frameAt(mediaPath, info.isVideo ? durationSec / 2 : null, thumbPath);
    const extra: string[] = [];
    if (info.isVideo && durationSec > 6) {
      for (const at of [durationSec * 0.15, durationSec * 0.85]) {
        const p = path.join(/* turbopackIgnore: true */ dir, `${id}.f${extra.length}.jpg`);
        await frameAt(mediaPath, at, p);
        extra.push(p);
      }
    }
    const { description, tags } = await describe(supabase, file.name, [thumbPath, ...extra]);
    await Promise.all(extra.map((p) => fs.unlink(p).catch(() => {})));
    const clip: LibraryClip = {
      id,
      name: file.name.slice(0, 200),
      path: mediaPath,
      thumbPath,
      isVideo: info.isVideo,
      durationSec,
      description,
      tags,
      license: file.license,
      attribution: file.attribution ?? null,
      addedAt: new Date().toISOString(),
    };
    await saveIndex([...(await listLibrary()), clip]);
    return clip;
  } catch (err) {
    await fs.unlink(mediaPath).catch(() => {});
    throw err;
  }
}

export async function removeFromLibrary(id: string): Promise<boolean> {
  const list = await listLibrary();
  const clip = list.find((c) => c.id === id);
  if (!clip) return false;
  await saveIndex(list.filter((c) => c.id !== id));
  await Promise.all([clip.path, clip.thumbPath].map((p) => fs.unlink(p).catch(() => {})));
  return true;
}

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'and', 'or', 'with', 'to', 'for', 'from', 'by', 'shot', 'footage', 'photo', 'video', 'close', 'wide']);
const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)));

/**
 * Library clips that share subject words with the shot, best first, as picker candidates. The
 * relevance check still decides whether they fit; this only decides which are worth showing it.
 */
export function searchLibrary(query: string, clips: LibraryClip[], limit = 3): MediaCandidate[] {
  const want = words(query);
  if (want.size === 0) return [];
  return clips
    .map((c) => {
      const have = words(`${c.description} ${c.tags.join(' ')} ${c.name}`);
      return { c, shared: [...want].filter((w) => have.has(w)).length };
    })
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, limit)
    .map(({ c }) => ({
      id: `library_${c.id}`,
      provider: 'uploaded' as const,
      mediaType: c.isVideo ? ('video' as const) : ('image' as const),
      title: c.description,
      thumbnailUrl: c.thumbPath,
      downloadUrl: c.path,
      pageUrl: `library:${c.id}`,
      duration: c.durationSec,
      license: c.license,
      attribution: c.attribution ?? 'Your footage library',
    }));
}
