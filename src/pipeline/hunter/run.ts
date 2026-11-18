import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { measureLoudness } from '../clipping/analyze';
import { getFfmpegPath } from '../utils/ffmpeg';
import { findCandidates } from './candidates';
import { gatherSpeech, judgeCandidates } from './judge';
import { downloadAudio, downloadSection, downloadYoutubeCaptions, downloadYoutubeChat, MAX_STREAM_SEC, normalizeStreamUrl, parseUploadedChat, probeStream } from './source';
import { huntDir, loadHunt, newHuntId, saveHunt, updateHunt } from './store';
import type { Hunt, HuntStatus, TimedText } from './types';

const execFileAsync = promisify(execFile);

/**
 * A hunt: stream details -> sound, chat and captions -> flagged stretches -> the judge's picks ->
 * each pick cut out of the stream. Hunts run one at a time, in the order they were started.
 *
 *   all:  everything, from the download
 *   cut:  cut again any moments that are missing or failed
 */
export type HuntRunFrom = 'all' | 'cut';

const state = globalThis as unknown as { __huntQueue?: Promise<void>; __huntQueued?: Set<string> };

export const isHuntBusy = (id: string) => state.__huntQueued?.has(id) ?? false;

export function enqueueHunt(id: string, from: HuntRunFrom): void {
  state.__huntQueued ??= new Set();
  state.__huntQueued.add(id);
  state.__huntQueue = (state.__huntQueue ?? Promise.resolve())
    .then(() => processHunt(id, from))
    .catch((err) => console.error(`[Hunter] ${id} failed:`, err))
    .finally(() => state.__huntQueued?.delete(id));
}

export async function createHunt(input: { url: string; creator?: string; maxMoments?: number; chatJson?: string }): Promise<Hunt> {
  const link = normalizeStreamUrl(input.url);
  const now = new Date().toISOString();
  const id = newHuntId();
  // An uploaded chat log is checked now, so a bad file is refused before anything starts
  const uploaded = input.chatJson ? parseUploadedChat(input.chatJson) : null;
  const hunt = await saveHunt({
    id,
    url: link.url,
    platform: link.platform,
    title: '',
    uploader: '',
    uploaderHandle: '',
    pageUrl: link.url,
    durationSec: 0,
    creator: (input.creator ?? '').trim(),
    maxMoments: Math.min(30, Math.max(3, Math.round(input.maxMoments ?? 12))),
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    step: 'Waiting to start',
    warnings: [],
    signals: { chat: 0, captions: false, audio: false, uploadedChat: Boolean(uploaded) },
    candidates: [],
    moments: [],
  });
  if (uploaded) await fs.writeFile(path.join(huntDir(id), 'chat-uploaded.json'), JSON.stringify(uploaded), 'utf-8');
  enqueueHunt(id, 'all');
  return hunt;
}

async function setStep(id: string, status: HuntStatus, step: string, progress?: number) {
  await updateHunt(id, (h) => {
    h.status = status;
    h.step = step;
    h.progress = progress;
    delete h.error;
  });
}

/** Throttled progress reports (at most one write per percent step and second). */
function reporter(id: string, status: HuntStatus, step: (n: number) => string, total: number) {
  let last = 0;
  let lastPct = -1;
  return async (done: number) => {
    const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
    if (pct === lastPct || (Date.now() - last < 1000 && done < total)) return;
    last = Date.now();
    lastPct = pct;
    await setStep(id, status, step(done), pct);
  };
}

/** YouTube links jump to a time with &t=; Twitch with ?t=1h2m3s. */
export function timestampUrl(pageUrl: string, platform: string, sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (platform === 'YouTube') return `${pageUrl}${pageUrl.includes('?') ? '&' : '?'}t=${s}`;
  if (platform === 'Twitch') return `${pageUrl.split('?')[0]}?t=${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
  return pageUrl;
}

export async function processHunt(id: string, from: HuntRunFrom): Promise<void> {
  const dir = huntDir(id);
  try {
    let hunt = await loadHunt(id);
    if (!hunt) return;

    if (from === 'all') {
      await setStep(id, 'probing', 'Reading the stream details');
      const info = await probeStream(hunt.url, hunt.platform);
      if (info.isLive) throw new Error('This stream is still live. Hunt it once it has ended.');
      if (info.durationSec > MAX_STREAM_SEC) throw new Error(`The stream is longer than ${MAX_STREAM_SEC / 3600} hours`);
      hunt = await updateHunt(id, (h) => {
        Object.assign(h, { title: info.title, uploader: info.uploader, uploaderHandle: info.uploaderHandle, pageUrl: info.pageUrl, durationSec: info.durationSec });
        h.warnings = [];
        h.moments = [];
        h.candidates = [];
      });
      const warnings: string[] = [];

      // Chat: an uploaded log wins; else YouTube's replay
      let chat: TimedText[] = [];
      const uploadedFile = path.join(dir, 'chat-uploaded.json');
      if (await fs.stat(uploadedFile).then(() => true).catch(() => false)) {
        chat = JSON.parse(await fs.readFile(uploadedFile, 'utf-8')) as TimedText[];
      } else if (info.hasChat) {
        await setStep(id, 'listening', 'Downloading the chat replay');
        chat = await downloadYoutubeChat(hunt.url, dir).catch((err) => {
          warnings.push(`The chat replay could not be downloaded: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
          return [];
        });
      } else if (hunt.platform !== 'YouTube') {
        warnings.push(`${hunt.platform} chat can't be fetched automatically, so moments were found from the sound and speech. For better results, export the chat with TwitchDownloader and upload it when starting a hunt.`);
      } else {
        warnings.push('This stream has no chat replay, so moments were found from the sound and speech.');
      }

      let captions: TimedText[] = [];
      if (info.captionLang) {
        await setStep(id, 'listening', 'Downloading YouTube\'s captions');
        captions = await downloadYoutubeCaptions(hunt.url, info.captionLang, dir).catch(() => []);
      }

      const audio = await downloadAudio(hunt.url, hunt.platform, dir, (pct) => {
        void setStep(id, 'listening', `Downloading the stream's sound (${pct}%)`, pct).catch(() => {});
      });

      await setStep(id, 'scanning', 'Measuring the sound across the whole stream');
      const loudness = await measureLoudness(path.join(dir, audio));
      await fs.writeFile(path.join(dir, 'signals.json'), JSON.stringify({ loudness, chat, captions }), 'utf-8');

      const durationSec = info.durationSec || loudness.length * 0.5;
      const candidates = findCandidates({ durationSec, loudness, chat, captions });
      if (!candidates.length) throw new Error('Nothing stood out in this stream (no loud moments or chat spikes found)');
      hunt = await updateHunt(id, (h) => {
        h.durationSec = durationSec;
        h.candidates = candidates;
        h.signals = { chat: chat.length, captions: captions.length > 0, audio: true, uploadedChat: h.signals.uploadedChat };
      });

      // What was said in each stretch
      const { speech, warnings: speechWarnings } = await gatherSpeech(
        dir,
        audio,
        candidates,
        captions,
        reporter(id, 'judging', (n) => `Listening to flagged moment ${n} of ${candidates.length}`, candidates.length),
      );
      warnings.push(...speechWarnings);

      await setStep(id, 'judging', 'Judging which moments make good Shorts');
      const contexts = candidates.map((candidate, i) => ({ candidate, speech: speech[i], chat: chat.filter((m) => m.t >= candidate.start && m.t <= candidate.end + 15) }));
      const { moments, warnings: judgeWarnings } = await judgeCandidates(
        { title: hunt.title, uploader: hunt.uploader, durationSec },
        contexts,
        hunt.maxMoments,
        reporter(id, 'judging', (n) => `Judging moments (${n} of ${candidates.length})`, candidates.length),
      );
      warnings.push(...judgeWarnings);
      if (!moments.length) throw new Error('The judge found no moments that would make a good Short in this stream');
      hunt = await updateHunt(id, (h) => {
        h.moments = moments;
        h.warnings = [...new Set(warnings)];
      });
      // The sound was only needed for finding moments
      await fs.unlink(path.join(dir, audio)).catch(() => {});
    }

    // Cut each moment out of the stream
    const todo = hunt.moments.filter((m) => !m.discarded && m.status !== 'cut');
    for (const [n, m] of todo.entries()) {
      await setStep(id, 'cutting', `Cutting moment ${n + 1} of ${todo.length}`, Math.floor((n / todo.length) * 100));
      try {
        const file = await downloadSection(hunt.url, hunt.platform, m.start, m.end, path.join(dir, 'moments', m.id));
        const thumb = path.join(dir, 'moments', `${m.id}.jpg`);
        await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', ((m.end - m.start) / 2).toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb]).catch(() => {});
        await updateHunt(id, (h) => {
          const x = h.moments.find((y) => y.id === m.id);
          if (x) Object.assign(x, { status: 'cut', file: path.relative(dir, file).replace(/\\/g, '/'), thumb: `moments/${m.id}.jpg`, error: undefined });
        });
      } catch (err) {
        await updateHunt(id, (h) => {
          const x = h.moments.find((y) => y.id === m.id);
          if (x) Object.assign(x, { status: 'failed', error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        });
      }
    }

    await updateHunt(id, (h) => {
      h.status = 'ready';
      h.step = 'Ready';
      h.progress = undefined;
    });
  } catch (err) {
    await updateHunt(id, (h) => {
      h.status = 'failed';
      h.step = 'Failed';
      h.progress = undefined;
      h.error = err instanceof Error ? err.message : String(err);
    }).catch(() => {});
    throw err;
  }
}
