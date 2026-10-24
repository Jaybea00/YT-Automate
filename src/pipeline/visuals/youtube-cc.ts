import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import type { MediaCandidate } from './types';

const execFileAsync = promisify(execFile);

/**
 * Creative Commons footage from YouTube, for shots the stock libraries and archives can't fill.
 * Only videos YouTube lists as "Creative Commons Attribution" are used; re-uploads of broadcasts,
 * match highlights and the like are turned away; each is credited to its channel with a link. Only
 * the start of the video is downloaded (where the footage picker then finds the matching seconds).
 */

const API = 'https://www.googleapis.com/youtube/v3';
/** A search costs 100 of YouTube's 10,000 free daily units: stay well inside. */
export const DAILY_SEARCH_LIMIT = 80;
/** How much of a video is fetched: the first few minutes are plenty to find a shot in. */
export const DOWNLOAD_SECONDS = 240;
const MAX_VIDEO_MIN = 90;

/** Titles that say the video is someone else's broadcast or a compilation of it. */
const REJECT_TITLE =
  /\b(full match|highlights|extended highlights|live ?stream|reaction|reacts?|compilation|trailer|episode|full movie|official video|music video|lyrics|news live|podcast|interview|tutorial|unboxing|gameplay|walkthrough|vlog)\b/i;
/** Channels that are broadcasters: their "CC" uploads are rare and often mislabelled re-uploads. */
const BROADCASTERS = /\b(bbc|sky sports|espn|cnn|fox|nbc|abc news|cbs|itv|bt sport|dazn|tnt sports|beins?|uefa|fifa|premier league|nba|nfl|reuters|ap archive|al jazeera)\b/i;

const yt = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** ISO 8601 duration ("PT4M13S") in seconds. */
export function isoSeconds(iso: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

// ---- Daily allowance ----

const quotaFile = () => process.env.YOUTUBE_QUOTA_FILE || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'data-cache', 'youtube-quota.json');

/** Takes one search from today's allowance; false when it's used up (search elsewhere instead). */
export async function takeSearch(today = new Date().toISOString().slice(0, 10)): Promise<boolean> {
  let state = { day: today, searches: 0 };
  try {
    const saved = JSON.parse(await fs.readFile(quotaFile(), 'utf-8')) as typeof state;
    if (saved.day === today) state = saved;
  } catch {
    // first search today
  }
  if (state.searches >= DAILY_SEARCH_LIMIT) return false;
  state.searches++;
  await fs.mkdir(path.dirname(quotaFile()), { recursive: true });
  await fs.writeFile(quotaFile(), JSON.stringify(state), 'utf-8');
  return true;
}

// ---- Search ----

interface SearchItem {
  id: { videoId: string };
}
interface VideoItem {
  id: string;
  snippet: { title: string; channelTitle: string; thumbnails?: Record<string, { url: string }> };
  status?: { license?: string; embeddable?: boolean };
  contentDetails?: { duration?: string };
}

/** Whether a video is real CC footage worth considering. */
export function acceptVideo(v: VideoItem): boolean {
  if (v.status?.license !== 'creativeCommon') return false;
  const sec = isoSeconds(v.contentDetails?.duration ?? '');
  if (sec < 5 || sec > MAX_VIDEO_MIN * 60) return false;
  if (REJECT_TITLE.test(v.snippet.title)) return false;
  if (BROADCASTERS.test(v.snippet.channelTitle) || BROADCASTERS.test(v.snippet.title)) return false;
  return true;
}

/** Creative Commons videos for a search, as footage candidates (best first, at most `limit`). */
export async function searchYoutubeCc(query: string, options: { apiKey?: string; limit?: number; fetcher?: typeof fetch } = {}): Promise<MediaCandidate[]> {
  const apiKey = options.apiKey ?? process.env.YOUTUBE_API_KEY;
  const fetcher = options.fetcher ?? fetch;
  if (!apiKey || !query.trim()) return [];
  // Downloads are being refused: searching would only find clips that can't be fetched
  if (downloadsBlocked()) return [];
  if (!(await takeSearch())) {
    console.warn('[YouTube CC] Today\'s search allowance is used up; skipping YouTube');
    return [];
  }
  const search = new URL(`${API}/search`);
  Object.entries({ part: 'id', q: query, type: 'video', videoLicense: 'creativeCommon', safeSearch: 'strict', maxResults: '10', key: apiKey }).forEach(([k, v]) => search.searchParams.set(k, v));
  const sres = await fetcher(search, { signal: AbortSignal.timeout(20_000) });
  if (!sres.ok) throw new Error(`YouTube search failed (${sres.status})`);
  const ids = (((await sres.json()) as { items?: SearchItem[] }).items ?? []).map((i) => i.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  // Confirm each one's licence and length (1 unit for all of them)
  const details = new URL(`${API}/videos`);
  Object.entries({ part: 'snippet,status,contentDetails', id: ids.join(','), key: apiKey }).forEach(([k, v]) => details.searchParams.set(k, v));
  const dres = await fetcher(details, { signal: AbortSignal.timeout(20_000) });
  if (!dres.ok) throw new Error(`YouTube video details failed (${dres.status})`);
  const videos = ((await dres.json()) as { items?: VideoItem[] }).items ?? [];
  return videos
    .filter(acceptVideo)
    .slice(0, options.limit ?? 4)
    .map((v) => {
      const thumbs = v.snippet.thumbnails ?? {};
      return {
        id: `yt_${v.id}`,
        provider: 'youtube_cc' as const,
        mediaType: 'video' as const,
        title: v.snippet.title,
        thumbnailUrl: (thumbs.maxres ?? thumbs.high ?? thumbs.medium ?? thumbs.default)?.url ?? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        downloadUrl: yt(v.id),
        pageUrl: yt(v.id),
        duration: isoSeconds(v.contentDetails?.duration ?? ''),
        attribution: `Footage: "${v.snippet.title.slice(0, 80)}" by ${v.snippet.channelTitle} on YouTube (CC BY), ${yt(v.id)}`,
        license: 'cc_by',
        licenseProofUrl: yt(v.id),
      };
    });
}

// ---- Download (yt-dlp) ----

const binDir = () => path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'bin');
const exeName = () => (process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp');

/**
 * The yt-dlp program: YTDLP_PATH, one already on this computer, or (first use) the official
 * self-contained build downloaded into storage/bin.
 */
export async function ensureYtDlp(fetcher: typeof fetch = fetch): Promise<string> {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const local = path.join(binDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (await fs.stat(local).then((s) => s.size > 1_000_000).catch(() => false)) return local;
  try {
    await execFileAsync('yt-dlp', ['--version'], { timeout: 15_000 });
    return 'yt-dlp';
  } catch {
    // not installed: fetch the official build
  }
  const res = await fetcher(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${exeName()}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Could not download yt-dlp (${res.status})`);
  await fs.mkdir(binDir(), { recursive: true });
  const tmp = `${local}.part`;
  await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  if (process.platform !== 'win32') await fs.chmod(tmp, 0o755);
  await fs.rename(tmp, local);
  return local;
}

/**
 * The YouTube sign-in yt-dlp uses, from .env.local: YTDLP_COOKIES_FROM_BROWSER ("firefox",
 * "edge", "chrome"...) or YTDLP_COOKIES (a cookies.txt file). YouTube refuses many unsigned
 * downloads ("confirm you're not a bot").
 */
export function cookieArgs(env: Record<string, string | undefined> = process.env): string[] {
  if (env.YTDLP_COOKIES) return ['--cookies', env.YTDLP_COOKIES];
  if (env.YTDLP_COOKIES_FROM_BROWSER) return ['--cookies-from-browser', env.YTDLP_COOKIES_FROM_BROWSER];
  return [];
}

/** yt-dlp's arguments: picture only, up to 1080p, the first DOWNLOAD_SECONDS, as MP4. */
export function ytDlpArgs(url: string, outputPath: string, ffmpegDir: string | null, env: Record<string, string | undefined> = process.env): string[] {
  return [
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    ...cookieArgs(env),
    // YouTube hands out video formats only after a JavaScript challenge: solved with Node (which
    // runs this app) and yt-dlp's official solver script
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    '-f', 'bv*[height<=1080][ext=mp4]/bv*[height<=1080]/b[height<=1080]/bv*/b',
    '--download-sections', `*0-${DOWNLOAD_SECONDS}`,
    '--remux-video', 'mp4',
    ...(ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : []),
    '-o', outputPath,
    url,
  ];
}

/** When YouTube refuses downloads (a bot check), YouTube rests this long before it's tried again. */
const BLOCK_MS = 60 * 60 * 1000;
let blockedUntil = 0;
export const downloadsBlocked = (now = Date.now()) => now < blockedUntil;
export const resetDownloadBlock = () => {
  blockedUntil = 0;
};
/** A refusal that a sign-in (cookies) would fix, rather than a broken video. */
export const isBotCheck = (message: string) => /confirm you.?re not a bot|sign in to confirm|HTTP Error 429|Only images are available/i.test(message);

/** Downloads the start of a CC video for the footage picker (picture only). */
export async function downloadYoutubeCc(url: string, targetPath: string): Promise<string> {
  const bin = await ensureYtDlp();
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const ffmpeg = getFfmpegPath();
  const ffmpegDir = path.isAbsolute(ffmpeg) ? path.dirname(ffmpeg) : null;
  try {
    await execFileAsync(bin, ytDlpArgs(url, targetPath, ffmpegDir), { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const message = err instanceof Error ? `${err.message} ${(err as { stderr?: string }).stderr ?? ''}` : String(err);
    if (isBotCheck(message)) {
      blockedUntil = Date.now() + BLOCK_MS;
      console.warn(
        `[YouTube CC] YouTube refused the download (bot check). ${cookieArgs().length ? 'The sign-in in .env.local did not work.' : 'Set YTDLP_COOKIES_FROM_BROWSER (e.g. firefox) in .env.local.'} YouTube footage is paused for an hour.`,
      );
      throw new Error('YouTube refused the download (sign-in needed)');
    }
    throw err;
  }
  if (!(await fs.stat(targetPath).then((s) => s.size > 0).catch(() => false))) throw new Error('yt-dlp produced no file');
  return targetPath;
}
