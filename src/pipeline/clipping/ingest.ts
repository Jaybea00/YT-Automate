import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import { cookieArgs, ensureYtDlp, isBotCheck } from '../visuals/youtube-cc';
import type { ClipSource } from './types';

const execFileAsync = promisify(execFile);

/** Longest source accepted: clips, not whole streams (those are the stream hunter's job). */
export const MAX_SOURCE_SEC = 20 * 60;

/**
 * A pasted link made fit for yt-dlp: share-tracking parameters dropped, and for X posts the
 * video number ("/video/2") turned into which item of the post to take.
 */
export function normalizeClipUrl(raw: string): { url: string; item: number | null; platform: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('That is not a link. Paste the full address, starting with https://');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links can be used');
  const host = u.hostname.replace(/^(www|mobile|m)\./, '').toLowerCase();

  if (host === 'x.com' || host === 'twitter.com') {
    const m = u.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/(?:video|photo)\/(\d+))?/);
    if (!m) throw new Error('This X link does not point at a post (it should contain /status/)');
    return { url: `https://x.com/${m[1]}/status/${m[2]}`, item: m[3] ? Number(m[3]) : null, platform: 'X' };
  }
  if (host === 'youtube.com' || host === 'youtu.be') {
    const id = host === 'youtu.be' ? u.pathname.slice(1) : u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : u.searchParams.get('v');
    if (!id) throw new Error('This YouTube link has no video in it');
    return { url: `https://www.youtube.com/watch?v=${id}`, item: null, platform: 'YouTube' };
  }
  if (host.endsWith('twitch.tv')) {
    u.search = '';
    return { url: u.toString(), item: null, platform: 'Twitch' };
  }
  if (host === 'kick.com') {
    u.search = '';
    return { url: u.toString(), item: null, platform: 'Kick' };
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    u.search = '';
    return { url: u.toString(), item: null, platform: 'TikTok' };
  }
  if (host === 'instagram.com') {
    u.search = '';
    return { url: u.toString(), item: null, platform: 'Instagram' };
  }
  return { url: u.toString(), item: null, platform: host };
}

/**
 * The sign-in yt-dlp uses (see cookieArgs), dropped when YTDLP_COOKIES names a file that isn't
 * there: yt-dlp crashes on a missing cookies file instead of downloading without it.
 */
export async function usableCookieArgs(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const args = cookieArgs(env);
  if (args[0] === '--cookies' && !(await fs.stat(args[1]).then((s) => s.isFile()).catch(() => false))) {
    console.warn(`[Clipping] YTDLP_COOKIES points at ${args[1]}, which does not exist; downloading without a sign-in`);
    return [];
  }
  return args;
}

/** yt-dlp's arguments: best video up to 1080p with its sound, as one MP4, plus the post's details. */
export function ingestArgs(link: { url: string; item: number | null; platform: string }, outBase: string, ffmpegDir: string | null, cookies: string[] = []): string[] {
  const youtube = link.platform === 'YouTube';
  return [
    '--no-warnings',
    '--quiet',
    ...(link.item ? ['--playlist-items', String(link.item)] : ['--no-playlist', '--playlist-items', '1']),
    ...cookies,
    // YouTube hands out formats only after a JavaScript challenge (see youtube-cc.ts)
    ...(youtube ? ['--js-runtimes', 'node', '--remote-components', 'ejs:github'] : []),
    // "<=?" also lets through posts whose length isn't known in advance
    '--match-filter', `duration <=? ${MAX_SOURCE_SEC}`,
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '--write-info-json',
    ...(ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : []),
    '-o', `${outBase}.%(ext)s`,
    link.url,
  ];
}

interface InfoJson {
  title?: string;
  fulltitle?: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  channel?: string;
  webpage_url?: string;
}

/** The post's details, from yt-dlp's info file. */
export function sourceFromInfo(info: InfoJson, platform: string, pageUrl: string, file: string): ClipSource {
  const handleRaw = info.uploader_id || '';
  const uploaderHandle = handleRaw && !/^\d+$/.test(handleRaw) ? `@${handleRaw.replace(/^@/, '')}` : '';
  return {
    title: (info.fulltitle || info.title || '').trim(),
    postText: (info.description || '').trim(),
    uploader: (info.uploader || info.channel || '').trim(),
    uploaderHandle,
    platform,
    pageUrl: info.webpage_url || pageUrl,
    file,
  };
}

/** Downloads the clip behind a link into the clip folder. */
export async function downloadClip(rawUrl: string, dir: string): Promise<ClipSource> {
  const link = normalizeClipUrl(rawUrl);
  await fs.mkdir(dir, { recursive: true });
  const bin = await ensureYtDlp();
  const ffmpeg = getFfmpegPath();
  const ffmpegDir = path.isAbsolute(ffmpeg) ? path.dirname(ffmpeg) : null;
  const outBase = path.join(dir, 'source');
  try {
    await execFileAsync(bin, ingestArgs(link, outBase, ffmpegDir, await usableCookieArgs()), { timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const message = err instanceof Error ? `${err.message} ${(err as { stderr?: string }).stderr ?? ''}` : String(err);
    if (isBotCheck(message)) throw new Error(`${link.platform} refused the download and wants a sign-in. Set YTDLP_COOKIES in .env.local.`);
    if (/No video could be found|no video in this post/i.test(message)) throw new Error('That post has no video in it');
    if (/does not pass filter/i.test(message)) throw new Error(`The video is longer than ${MAX_SOURCE_SEC / 60} minutes; paste a clip, not a whole stream`);
    throw new Error(`Download failed: ${message.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`);
  }

  const files = await fs.readdir(dir);
  const video = files.find((f) => /^source\.(mp4|mkv|webm|mov)$/i.test(f));
  if (!video) throw new Error('The download finished but no video file was saved (the post may hold only images)');
  const infoName = files.find((f) => /^source\..*info\.json$/i.test(f));
  const info = infoName ? (JSON.parse(await fs.readFile(path.join(dir, infoName), 'utf-8')) as InfoJson) : {};
  return sourceFromInfo(info, link.platform, link.url, video);
}
