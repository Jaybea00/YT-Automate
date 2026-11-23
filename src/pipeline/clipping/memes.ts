import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import type { CutIn, MemeFile } from './types';

const execFileAsync = promisify(execFile);

/**
 * Meme cut-ins come from, in order:
 *   1. the meme library, storage/memes: your own downloads, named by what they are
 *      ("its-working.mp4", "bro got me.gif"); folders count as words too ("shocked/guy1.mp4")
 *   2. GIPHY (GIPHY_API_KEY in .env.local, free at developers.giphy.com)
 *   3. Tenor (TENOR_API_KEY, a Google Cloud key with the Tenor API turned on)
 * Whatever is found is normalised into the clip folder, so a render never depends on the web.
 */

export const memeLibraryDir = () => process.env.MEME_LIBRARY_DIR || path.join(process.cwd(), 'storage', 'memes');
const MEDIA = /\.(mp4|mov|webm|mkv|gif)$/i;

export interface MemeOption {
  source: MemeFile['source'];
  title: string;
  /** A library file path, or a download URL. */
  location: string;
  /** Where it came from, for the record. */
  origin: string;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
const STOP = new Set([
  'the', 'a', 'an', 'is', 'it', 'of', 'and', 'to', 'in', 'on', 'by', 'with', 'for', 'from', 'used', 'my', 'no', 'hd', 'high', 'quality', 'free', 'copyright', 'download',
  'meme', 'memes', 'gif', 'mp4', 'mp3', 'wav', 'sound', 'sounds', 'effect', 'effects', 'sfx', 'audio',
]);

/** Library files that share words with the query, best match first (ties keep the listing order). */
export function libraryMatches(files: string[], query: string): string[] {
  const q = words(query);
  if (!q.length) return [];
  const scored = files
    .map((f, i) => {
      const w = new Set(words(f.replace(/\.[a-z0-9]{2,4}$/i, '')));
      const hits = q.filter((x) => w.has(x)).length;
      // All the query's words beat some of them; among equals, the name with fewer extra words is closer
      return { f, i, score: hits / q.length + (hits === q.length ? 1 : 0) - Math.max(0, w.size - hits) * 0.01 };
    })
    .filter((x) => x.score > 0);
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.f);
}

/** Media files under a folder (and its subfolders), relative paths, sorted. */
export async function listLibrary(dir = memeLibraryDir(), media: RegExp = MEDIA): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, rel: string) {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(d, e.name), path.join(rel, e.name));
      else if (media.test(e.name)) out.push(path.join(rel, e.name));
    }
  }
  await walk(dir, '');
  return out.sort();
}

type Fetcher = typeof fetch;

export async function searchGiphy(query: string, key: string, fetcher: Fetcher = fetch): Promise<MemeOption[]> {
  const url = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&limit=10&rating=pg-13&lang=en`;
  const res = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GIPHY search failed (${res.status})`);
  const body = (await res.json()) as { data?: Array<{ title?: string; url?: string; images?: Record<string, { mp4?: string }> }> };
  return (body.data ?? [])
    .map((g) => ({ source: 'giphy' as const, title: g.title || query, location: g.images?.original?.mp4 || g.images?.original_mp4?.mp4 || '', origin: g.url || '' }))
    .filter((o) => o.location);
}

export async function searchTenor(query: string, key: string, fetcher: Fetcher = fetch): Promise<MemeOption[]> {
  const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}&client_key=clip_shorts&limit=10&media_filter=mp4&contentfilter=medium`;
  const res = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Tenor search failed (${res.status})`);
  const body = (await res.json()) as { results?: Array<{ content_description?: string; itemurl?: string; media_formats?: Record<string, { url?: string }> }> };
  return (body.results ?? [])
    .map((r) => ({ source: 'tenor' as const, title: r.content_description || query, location: r.media_formats?.mp4?.url || '', origin: r.itemurl || '' }))
    .filter((o) => o.location);
}

/** The best MP4 in a KLIPY item: its files come in sizes (hd, md, sm, xs), each in several formats. */
export function klipyMp4(item: unknown): string {
  const found: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 5 || v == null) return;
    if (typeof v === 'string') {
      if (/^https:\/\/[^\s]+\.mp4(\?|$)/i.test(v)) found.push(v);
      return;
    }
    if (typeof v === 'object') for (const [, x] of Object.entries(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  const file = (item as { file?: Record<string, unknown> })?.file;
  for (const size of ['hd', 'md', 'sm', 'xs']) {
    walk(file?.[size], 0);
    if (found.length) return found[0];
  }
  walk(item, 0);
  return found[0] ?? '';
}

/**
 * KLIPY search: clips (short video moments, with their sound) or GIFs. The key goes in the path;
 * results are in data.data[].
 */
export async function searchKlipy(query: string, key: string, kind: 'clips' | 'gifs', fetcher: Fetcher = fetch): Promise<MemeOption[]> {
  const url = `https://api.klipy.com/api/v1/${encodeURIComponent(key)}/${kind}/search?page=1&per_page=${kind === 'clips' ? 12 : 10}&q=${encodeURIComponent(query)}&customer_id=clip-shorts&locale=us&content_filter=medium`;
  const res = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`KLIPY ${kind} search failed (${res.status})`);
  const body = (await res.json()) as { data?: { data?: Array<{ title?: string; slug?: string; type?: string }> } };
  return (body.data?.data ?? [])
    .filter((i) => !i.type || i.type !== 'ad')
    .map((i) => ({ source: 'klipy' as const, title: i.title || query, location: klipyMp4(i), origin: i.slug ? `https://klipy.com/${kind}/${i.slug}` : '' }))
    .filter((o) => o.location);
}

/** Every option for a query, library first. Search failures become warnings, not errors. */
export async function memeOptions(query: string, env: Record<string, string | undefined> = process.env, fetcher: Fetcher = fetch): Promise<{ options: MemeOption[]; warnings: string[] }> {
  const warnings: string[] = [];
  const dir = env.MEME_LIBRARY_DIR || memeLibraryDir();
  const options: MemeOption[] = libraryMatches(await listLibrary(dir), query).map((f) => ({ source: 'library', title: path.basename(f).replace(MEDIA, ''), location: path.join(dir, f), origin: f }));
  const fail = (e: unknown) => (warnings.push(String(e instanceof Error ? e.message : e)), [] as MemeOption[]);
  // KLIPY clips first: real moments with their sound; then its GIFs
  if (env.KLIPY_API_KEY) {
    options.push(...(await searchKlipy(query, env.KLIPY_API_KEY, 'clips', fetcher).catch(fail)));
    options.push(...(await searchKlipy(query, env.KLIPY_API_KEY, 'gifs', fetcher).catch(fail)));
  }
  if (env.GIPHY_API_KEY) options.push(...(await searchGiphy(query, env.GIPHY_API_KEY, fetcher).catch((e) => (warnings.push(String(e instanceof Error ? e.message : e)), []))));
  if (env.TENOR_API_KEY) options.push(...(await searchTenor(query, env.TENOR_API_KEY, fetcher).catch((e) => (warnings.push(String(e instanceof Error ? e.message : e)), []))));
  const library = options.filter((o) => o.source === 'library');
  return { options: [...library, ...rankOnline(options.filter((o) => o.source !== 'library'), query)], warnings };
}

/**
 * Web results in a better order: the searches match loosely ("its mine now" brings "Not mine." and
 * song lyrics), so results whose titles hold more of the query's words come first, and lyric clips
 * (♪) go last. Equal ones keep the order they came in (KLIPY clips, its GIFs, GIPHY).
 */
export function rankOnline(options: MemeOption[], query: string): MemeOption[] {
  const q = words(query);
  const score = (o: MemeOption) => {
    const t = new Set(words(o.title));
    const hits = q.filter((w) => t.has(w)).length;
    return (q.length ? hits / q.length : 0) - (/[♪♫]/.test(o.title) ? 1 : 0) - (/^\s*not\b/i.test(o.title) && !/^not\b/i.test(query.trim()) ? 0.5 : 0);
  };
  return options
    .map((o, i) => ({ o, i, s: score(o) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.o);
}

export const memeKey = (c: Pick<CutIn, 'query' | 'pick'>) => `${(c.query ?? '').trim().toLowerCase()}|${c.pick ?? 0}`;

async function probe(file: string): Promise<{ durationSec: number; hasAudio: boolean }> {
  const { stderr } = await execFileAsync(getFfmpegPath(), ['-hide_banner', '-i', file], { maxBuffer: 8 * 1024 * 1024 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }));
  const m = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const durationSec = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  return { durationSec, hasAudio: /Stream #.*Audio:/.test(stderr) };
}

/** Copies (or downloads) a meme and turns it into a plain 30 fps H.264 MP4 at most 1080 wide, with its sound if it has any. */
async function normalise(option: MemeOption, outFile: string, fetcher: Fetcher): Promise<void> {
  const raw = `${outFile}.src${path.extname(option.location.split('?')[0]) || '.mp4'}`;
  if (option.source === 'library') await fs.copyFile(option.location, raw);
  else {
    const res = await fetcher(option.location, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 40 * 1024 * 1024) throw new Error('file too large');
    await fs.writeFile(raw, bytes);
  }
  try {
    const { hasAudio } = await probe(raw);
    await execFileAsync(
      getFfmpegPath(),
      [
        '-y', '-v', 'error', '-i', raw, '-t', '6',
        '-vf', "fps=30,scale='min(1080,iw)':-2,format=yuv420p",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'] : ['-an']),
        '-movflags', '+faststart', outFile,
      ],
      { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
    );
  } finally {
    await fs.unlink(raw).catch(() => {});
  }
}

/**
 * Finds a file for every meme cut-in whose query or pick changed (the rest keep theirs). A meme
 * with nothing found keeps no file, so the render leaves it out, and the clip gets a warning.
 */
export async function prepareMemes(dir: string, cutIns: CutIn[], env: Record<string, string | undefined> = process.env, fetcher: Fetcher = fetch): Promise<{ cutIns: CutIn[]; warnings: string[] }> {
  const warnings: string[] = [];
  const out: CutIn[] = [];
  for (const c of cutIns) {
    if (c.kind !== 'meme' || !c.query?.trim()) {
      out.push(c);
      continue;
    }
    const key = memeKey(c);
    if (c.meme?.key === key && (await fs.stat(path.join(dir, c.meme.file)).then((s) => s.size > 0).catch(() => false))) {
      out.push(c);
      continue;
    }
    const { options, warnings: w } = await memeOptions(c.query, env, fetcher);
    warnings.push(...w);
    if (!options.length) {
      warnings.push(`No meme found for "${c.query}". Put a file named like it in storage/memes${env.KLIPY_API_KEY || env.GIPHY_API_KEY || env.TENOR_API_KEY ? ', or try other words' : ', or add GIPHY_API_KEY to .env.local'}.`);
      out.push({ ...c, meme: undefined });
      continue;
    }
    // Try the picked option, then the ones after it, until one converts
    let meme: MemeFile | undefined;
    for (let k = 0; k < Math.min(options.length, 4) && !meme; k++) {
      const option = options[((c.pick ?? 0) + k) % options.length];
      const file = `memes/meme_${createHash('sha1').update(`${key}|${option.location}`).digest('hex').slice(0, 10)}.mp4`;
      try {
        await fs.mkdir(path.join(dir, 'memes'), { recursive: true });
        await normalise(option, path.join(dir, file), fetcher);
        const info = await probe(path.join(dir, file));
        if (info.durationSec <= 0) throw new Error('empty file');
        meme = { file, source: option.source, title: option.title.slice(0, 120), origin: option.origin, hasAudio: info.hasAudio, durationSec: Number(info.durationSec.toFixed(2)), key };
      } catch (err) {
        warnings.push(`Meme "${option.title.slice(0, 40)}" could not be used: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      }
    }
    out.push({ ...c, meme });
  }
  return { cutIns: out, warnings };
}
