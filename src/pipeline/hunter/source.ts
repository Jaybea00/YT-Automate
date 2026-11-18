import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import { ensureYtDlp } from '../visuals/youtube-cc';
import { usableCookieArgs } from '../clipping/ingest';
import type { TimedText } from './types';

const execFileAsync = promisify(execFile);

/** Longest stream accepted (12 hours). */
export const MAX_STREAM_SEC = 12 * 3600;

/** A stream link made fit for yt-dlp, and which site it's on. */
export function normalizeStreamUrl(raw: string): { url: string; platform: 'YouTube' | 'Twitch' | 'Kick' | 'Other' } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('That is not a link. Paste the full address, starting with https://');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links can be used');
  const host = u.hostname.replace(/^(www|m|mobile)\./, '').toLowerCase();
  if (host === 'youtube.com' || host === 'youtu.be') {
    const id = host === 'youtu.be' ? u.pathname.slice(1) : u.pathname.startsWith('/live/') ? u.pathname.split('/')[2] : u.searchParams.get('v');
    if (!id) throw new Error('This YouTube link has no video in it');
    return { url: `https://www.youtube.com/watch?v=${id}`, platform: 'YouTube' };
  }
  if (host.endsWith('twitch.tv')) {
    const m = u.pathname.match(/\/videos\/(\d+)/);
    if (!m) throw new Error('Paste a Twitch past-broadcast link (twitch.tv/videos/…), not a channel');
    return { url: `https://www.twitch.tv/videos/${m[1]}`, platform: 'Twitch' };
  }
  if (host === 'kick.com') {
    u.search = '';
    return { url: u.toString(), platform: 'Kick' };
  }
  return { url: u.toString(), platform: 'Other' };
}

const ytArgs = (platform: string) => (platform === 'YouTube' ? ['--js-runtimes', 'node', '--remote-components', 'ejs:github'] : []);
const ffmpegDirArgs = () => {
  const ffmpeg = getFfmpegPath();
  return path.isAbsolute(ffmpeg) ? ['--ffmpeg-location', path.dirname(ffmpeg)] : [];
};

function explain(err: unknown): Error {
  const message = err instanceof Error ? `${err.message} ${(err as { stderr?: string }).stderr ?? ''}` : String(err);
  if (/sign in|not a bot|members-only|subscriber/i.test(message)) return new Error('The site wants a sign-in for this stream (members-only, or a bot check). Set YTDLP_COOKIES in .env.local.');
  if (/private|unavailable|removed|does not exist/i.test(message)) return new Error('That stream is private, deleted, or no longer available');
  return new Error(message.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300));
}

export interface StreamInfo {
  title: string;
  uploader: string;
  uploaderHandle: string;
  pageUrl: string;
  durationSec: number;
  /** YouTube's chat replay is there to download. */
  hasChat: boolean;
  /** YouTube's English captions (auto or uploaded) are there to download. */
  captionLang: string | null;
  isLive: boolean;
}

export async function probeStream(url: string, platform: string): Promise<StreamInfo> {
  const bin = await ensureYtDlp();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(bin, ['--no-warnings', '-J', '--no-playlist', ...(await usableCookieArgs()), ...ytArgs(platform), url], { timeout: 3 * 60_000, maxBuffer: 256 * 1024 * 1024 }));
  } catch (err) {
    throw explain(err);
  }
  const j = JSON.parse(stdout) as {
    title?: string;
    uploader?: string;
    uploader_id?: string;
    channel?: string;
    webpage_url?: string;
    duration?: number;
    live_status?: string;
    is_live?: boolean;
    subtitles?: Record<string, unknown>;
    automatic_captions?: Record<string, unknown>;
  };
  const subs = Object.keys(j.subtitles ?? {});
  const auto = Object.keys(j.automatic_captions ?? {});
  const english = ['en-orig', 'en', 'en-US', 'en-GB'];
  const captionLang = english.find((l) => subs.includes(l)) ?? english.find((l) => auto.includes(l)) ?? null;
  const handle = j.uploader_id && !/^\d+$/.test(j.uploader_id) ? `@${j.uploader_id.replace(/^@/, '')}` : '';
  return {
    title: (j.title ?? '').trim(),
    uploader: (j.uploader || j.channel || '').trim(),
    uploaderHandle: handle,
    pageUrl: j.webpage_url || url,
    durationSec: j.duration ?? 0,
    hasChat: subs.includes('live_chat'),
    captionLang,
    isLive: Boolean(j.is_live) || j.live_status === 'is_live' || j.live_status === 'is_upcoming',
  };
}

/** Runs yt-dlp, reporting download percent as it goes. */
async function ytDlp(args: string[], onPercent?: (pct: number) => void, timeoutMs = 3 * 3600_000): Promise<void> {
  const bin = await ensureYtDlp();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ['--newline', '--progress-template', 'download:PCT %(progress._percent_str)s', ...args], { windowsHide: true });
    let stderr = '';
    let lastPct = -1;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      for (const m of d.toString().matchAll(/PCT\s+([\d.]+)%/g)) {
        const pct = Math.floor(Number(m[1]));
        if (pct !== lastPct) {
          lastPct = pct;
          onPercent?.(pct);
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`yt-dlp exited with code ${code}`), { stderr }));
    });
  });
}

/** The stream's sound only (much smaller than the video), as audio.<ext>. */
export async function downloadAudio(url: string, platform: string, dir: string, onPercent?: (pct: number) => void): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  try {
    await ytDlp(['--no-warnings', '--no-playlist', ...(await usableCookieArgs()), ...ytArgs(platform), '-f', 'ba[ext=m4a]/ba/b', ...ffmpegDirArgs(), '-o', path.join(dir, 'audio.%(ext)s'), url], onPercent);
  } catch (err) {
    throw explain(err);
  }
  const file = (await fs.readdir(dir)).find((f) => /^audio\.(m4a|webm|mp4|opus|aac|mp3|ts)$/i.test(f));
  if (!file) throw new Error('The stream\'s sound could not be downloaded');
  return file;
}

// --------------------------------------------------------------------------
// Chat and captions
// --------------------------------------------------------------------------

interface ChatRun {
  text?: string;
  emoji?: { shortcuts?: string[]; emojiId?: string };
}

/** YouTube's chat replay file (one JSON action per line) as timed messages. */
export function parseYoutubeChat(jsonLines: string): TimedText[] {
  const out: TimedText[] = [];
  for (const line of jsonLines.split('\n')) {
    if (!line.trim()) continue;
    let row: { replayChatItemAction?: { videoOffsetTimeMsec?: string; actions?: Array<{ addChatItemAction?: { item?: Record<string, { message?: { runs?: ChatRun[] } }> } }> } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const r = row.replayChatItemAction;
    if (!r) continue;
    const t = Number(r.videoOffsetTimeMsec ?? 0) / 1000;
    for (const a of r.actions ?? []) {
      const item = a.addChatItemAction?.item;
      const msg = item?.liveChatTextMessageRenderer ?? item?.liveChatPaidMessageRenderer;
      const runs = msg?.message?.runs;
      if (!runs) continue;
      const text = runs.map((x) => x.text ?? (x.emoji?.emojiId && x.emoji.emojiId.length <= 4 ? x.emoji.emojiId : x.emoji?.shortcuts?.[0] ?? '')).join('').trim();
      if (text) out.push({ t, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * A chat log the user uploads: TwitchDownloader's JSON ({ comments: [{ content_offset_seconds,
 * message: { body } }] }), or a plain list of { t, text }.
 */
export function parseUploadedChat(json: string): TimedText[] {
  const data = JSON.parse(json) as unknown;
  const out: TimedText[] = [];
  const comments = (data as { comments?: unknown[] })?.comments;
  if (Array.isArray(comments)) {
    for (const c of comments as Array<{ content_offset_seconds?: number; message?: { body?: string } }>) {
      if (typeof c.content_offset_seconds === 'number' && c.message?.body) out.push({ t: c.content_offset_seconds, text: c.message.body });
    }
  } else if (Array.isArray(data)) {
    for (const c of data as Array<{ t?: number; text?: string }>) if (typeof c.t === 'number' && c.text) out.push({ t: c.t, text: c.text });
  } else {
    throw new Error('The chat file is not a TwitchDownloader chat JSON');
  }
  if (!out.length) throw new Error('The chat file has no messages in it');
  return out.sort((a, b) => a.t - b.t);
}

/** YouTube's json3 captions as timed lines. */
export function parseJson3Captions(json: string): TimedText[] {
  const data = JSON.parse(json) as { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> };
  const out: TimedText[] = [];
  for (const e of data.events ?? []) {
    const text = (e.segs ?? []).map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (text && e.tStartMs != null) out.push({ t: e.tStartMs / 1000, text });
  }
  return out;
}

export async function downloadYoutubeChat(url: string, dir: string): Promise<TimedText[]> {
  try {
    await ytDlp(['--no-warnings', '--skip-download', '--write-subs', '--sub-langs', 'live_chat', ...(await usableCookieArgs()), ...ytArgs('YouTube'), '-o', path.join(dir, 'chat.%(ext)s'), url], undefined, 30 * 60_000);
  } catch (err) {
    throw explain(err);
  }
  const file = (await fs.readdir(dir)).find((f) => f.startsWith('chat.') && f.includes('live_chat'));
  if (!file) return [];
  return parseYoutubeChat(await fs.readFile(path.join(dir, file), 'utf-8'));
}

export async function downloadYoutubeCaptions(url: string, lang: string, dir: string): Promise<TimedText[]> {
  try {
    await ytDlp(['--no-warnings', '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', lang, '--sub-format', 'json3', ...(await usableCookieArgs()), ...ytArgs('YouTube'), '-o', path.join(dir, 'captions.%(ext)s'), url], undefined, 10 * 60_000);
  } catch (err) {
    throw explain(err);
  }
  const file = (await fs.readdir(dir)).find((f) => f.startsWith('captions.') && f.endsWith('.json3'));
  if (!file) return [];
  return parseJson3Captions(await fs.readFile(path.join(dir, file), 'utf-8'));
}

// --------------------------------------------------------------------------
// Cutting a moment out of the stream
// --------------------------------------------------------------------------

/** Downloads only [start, end] of the stream's video (up to 1080p) as one MP4. */
export async function downloadSection(url: string, platform: string, start: number, end: number, outBase: string): Promise<string> {
  await fs.mkdir(path.dirname(outBase), { recursive: true });
  try {
    await ytDlp(
      [
        '--no-warnings', '--no-playlist', ...(await usableCookieArgs()), ...ytArgs(platform),
        '-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
        '--download-sections', `*${start.toFixed(1)}-${end.toFixed(1)}`,
        '--merge-output-format', 'mp4', ...ffmpegDirArgs(),
        '-o', `${outBase}.%(ext)s`, url,
      ],
      undefined,
      20 * 60_000,
    );
  } catch (err) {
    throw explain(err);
  }
  const base = path.basename(outBase);
  const file = (await fs.readdir(path.dirname(outBase))).find((f) => f.startsWith(`${base}.`) && /\.(mp4|mkv|webm)$/i.test(f));
  if (!file) throw new Error('The moment could not be cut from the stream');
  return path.join(path.dirname(outBase), file);
}
