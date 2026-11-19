import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { FileState, GoogleAIFileManager } from '@google/generative-ai/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withWritingModel } from '@/lib/script/generate-script';
import { geminiLlm } from '../providers/llm/gemini';
import { resolveForStage } from '../providers/registry';
import type { LLMProvider } from '../providers/types';
import { rendersDir } from '../publish/publish-assets';
import { getFfmpegPath } from '../utils/ffmpeg';
import { isCaptionPreset } from '../assembly/captions';
import type { VideoTimeline } from '../utils/timeline';
import { replaceAiNotes } from './review-notes';

const execFileAsync = promisify(execFile);

/**
 * The AI watch-through: Gemini watches (and listens to) the finished video, with the script and
 * where each line falls, and pins review notes to the moments that need a fix: captions over a
 * face, a picture that doesn't match the line, a shot held too long, music over the voice, a
 * glitch, a typo on screen. Its notes join the creator's on Vibedit's scrubber; a new watch
 * replaces the last one's open notes.
 *
 * A small copy of the video (720p, 5 fps, mono sound) is uploaded to Gemini's file store, since
 * the master is far too big to send, and deleted again afterwards. It runs in the background,
 * with its progress in the render folder (watch-through.json).
 */

export const NOTE_KINDS = ['caption', 'picture_mismatch', 'pacing', 'sound', 'glitch', 'on_screen_text', 'repetition', 'opening'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  caption: 'Captions',
  picture_mismatch: 'Picture vs words',
  pacing: 'Pacing',
  sound: 'Sound',
  glitch: 'Glitch',
  on_screen_text: 'On-screen text',
  repetition: 'Repetition',
  opening: 'Opening',
};

export const MAX_AI_NOTES = 30;

export interface WatchStatus {
  state: 'preparing' | 'uploading' | 'watching' | 'done' | 'failed';
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** The render it watched (its modified time), so the page can say when it is out of date. */
  renderedAt?: string;
  notes?: number;
  /** Gemini's overall impression, in a sentence or two. */
  summary?: string;
  model?: string;
  error?: string;
}

const ABANDONED_MS = 20 * 60 * 1000;
export const isWatching = (s: WatchStatus | null, now = Date.now()) =>
  Boolean(s) && !['done', 'failed'].includes(s!.state) && now - Date.parse(s!.updatedAt) < ABANDONED_MS;

const statusFile = (videoId: string) => path.join(rendersDir(videoId), 'watch-through.json');
export const finalVideoPath = (videoId: string) => path.join(rendersDir(videoId), 'final_video.mp4');

export async function readWatchStatus(videoId: string): Promise<WatchStatus | null> {
  return fs.readFile(statusFile(videoId), 'utf-8').then((t) => JSON.parse(t) as WatchStatus).catch(() => null);
}

async function writeWatchStatus(videoId: string, status: WatchStatus): Promise<WatchStatus> {
  const next = { ...status, updatedAt: new Date().toISOString() };
  await fs.mkdir(path.dirname(statusFile(videoId)), { recursive: true });
  await fs.writeFile(statusFile(videoId), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export interface WatchContext {
  title: string;
  totalSec: number;
  beats: Array<{ index: number; startSec: number; voiceStartSec: number; text: string }>;
  chapters: Array<{ atSec: number; title: string }>;
  endScreenSec: number;
  captions: boolean;
}

/** What Gemini is told about the video besides watching it. */
export function buildWatchPrompt(c: WatchContext): string {
  const lines = c.beats.map((b) => `[${fmt(b.voiceStartSec)}] (beat ${b.index + 1}) ${b.text}`).join('\n');
  const chapters = c.chapters.length ? c.chapters.map((ch) => `${fmt(ch.atSec)} ${ch.title}`).join('; ') : 'none';
  return `You are a senior YouTube video editor doing a final review of "${c.title}" (${fmt(c.totalSec)}) before upload. Watch and listen to the whole video.

The narration, with when each line starts:
${lines}

Chapters (each change has an intended short dip or transition): ${chapters}.
${c.captions ? 'Captions are burned in, made word for word from the narration above, so they are spelled as the narration is: judge where they sit, whether they can be read and whether they keep time with the voice, never their spelling.' : 'The video has no burned-in captions.'}
${c.endScreenSec > 0 ? `The last ${Math.round(c.endScreenSec)} seconds are an intended end screen (a blurred still with a heading, music only).` : ''}
Freeze-frames with a short title, short zoom punches at chapter changes and slow camera moves on photos are intended effects.

Work through it in order, line by line. For each line, look at what is on screen while it is spoken: when a line names a specific kind of person, place, object or event ("athletes lifting a trophy", "the Suez canal") and the picture during that line clearly shows something else, that is a picture_mismatch. A shot may cover two lines only if it fits both.

Note only real problems a viewer would notice, each pinned to the second it happens:
- caption: captions hard to read, covering a face or important text, or out of step with the voice (not spelling: they are the narration's words)
- picture_mismatch: the picture clearly doesn't fit what is being said
- pacing: a shot held far too long, cuts too fast to follow, dead air, a stretch that drags
- sound: music drowning the voice, a sudden jump in loudness, a cut-off word, an effect at the wrong moment
- glitch: unintended black or frozen frames, stretched, blurry or low-quality pictures, a watermark or someone else's logo
- on_screen_text: a typo or wrong fact in text that is part of the picture (titles, labels, cards), not the captions; quote the text exactly and only if you can read it clearly
- repetition: the same picture shown again soon after
- opening: the first 15 seconds fail to hook (only if clearly weak)

Rules: at most ${MAX_AI_NOTES} notes, the most important first. Each note is one specific, fixable sentence that says what is wrong and what to do ("The map zooms out before the narrator names Suez; hold it 2 seconds longer"). at_sec is seconds from the start of the video. Severity: high = a viewer would click away or the video looks broken; medium = clearly noticeable; low = polish. Don't praise, don't repeat a note, and don't flag the intended effects above. Report only what you actually saw or heard; a clean video gets few or no notes. Also give a one or two sentence overall impression.`;
}

const WatchSchema = z.object({
  overall: z.string(),
  notes: z.array(
    z.object({
      at_sec: z.number(),
      kind: z.enum(NOTE_KINDS),
      severity: z.enum(['high', 'medium', 'low']),
      note: z.string(),
    }),
  ),
});
export type WatchResult = z.infer<typeof WatchSchema>;

/** The beat playing at a moment (the last beat whose scene has started). */
export function beatAt(beats: WatchContext['beats'], atSec: number): number {
  let found = beats[0]?.index ?? 0;
  for (const b of beats) if (b.startSec <= atSec + 0.05) found = b.index;
  return found;
}

/** Words, for comparing a note's quotes with the narration. */
const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

/**
 * A caption "typo" whose correction is just what the narration says: captions are made from the
 * narration's words, so the model misread them (a soft frame, a handwritten caption font).
 */
export function misreadCaption(note: string, narration: string): boolean {
  if (!/\b(instead of|typo|misspel|reads|missing a space|spelled)/i.test(note)) return false;
  // Quoted text; an apostrophe inside a word ("you're") is not a closing quote
  const quoted = [...note.matchAll(/(?<!\p{L})['"‘“](.{2,80}?)['"’”](?!\p{L})/gu)].map((m) => wordsOf(m[1])).filter(Boolean);
  const said = ` ${wordsOf(narration)} `;
  return quoted.some((q) => said.includes(` ${q} `));
}

/** Gemini's notes kept sane: inside the video, worded, one per moment and kind, most severe first, then in order. */
export function normalizeWatchNotes(raw: WatchResult['notes'], c: WatchContext) {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const kept: Array<{ atSec: number; beat: number; text: string; kind: NoteKind; severity: 'high' | 'medium' | 'low' }> = [];
  for (const n of [...raw].sort((a, b) => rank[a.severity] - rank[b.severity])) {
    const text = n.note.trim();
    if (!text || !Number.isFinite(n.at_sec)) continue;
    const atSec = Math.max(0, Math.min(c.totalSec, n.at_sec));
    const beat = beatAt(c.beats, atSec);
    if (n.kind === 'caption' || n.kind === 'on_screen_text') {
      // Captions are the narration: a "typo" correcting them to the narration is a misread
      const around = c.beats.filter((b) => Math.abs(b.index - beat) <= 1).map((b) => b.text).join(' ');
      if (misreadCaption(text, around)) continue;
    }
    if (kept.some((k) => k.kind === n.kind && Math.abs(k.atSec - atSec) < 3)) continue;
    kept.push({ atSec, beat, text, kind: n.kind, severity: n.severity });
    if (kept.length >= MAX_AI_NOTES) break;
  }
  return kept.sort((a, b) => a.atSec - b.atSec);
}

/** The video's script and timing, as the watch-through needs them. */
export async function loadWatchContext(supabase: SupabaseClient, videoId: string): Promise<WatchContext> {
  const { data: video } = await supabase.from('videos').select('title, topic, script_json').eq('id', videoId).maybeSingle();
  if (!video) throw new Error('Video not found');
  const sj = (video.script_json ?? {}) as {
    beats?: Array<{ text?: string; narration?: string }>;
    timeline?: VideoTimeline;
    sections?: { sections?: Array<{ start_beat: number; title: string }> };
    captions?: { preset?: string };
  };
  const timeline = sj.timeline;
  if (!timeline?.beats?.length) throw new Error('Render the video first: the watch-through needs the finished video and its timeline.');
  const beats = timeline.beats.map((b) => ({
    index: b.index,
    startSec: b.sceneStartMs / 1000,
    voiceStartSec: b.voiceStartMs / 1000,
    text: String(sj.beats?.[b.index]?.text ?? sj.beats?.[b.index]?.narration ?? '').trim(),
  }));
  const startOf = new Map(beats.map((b) => [b.index, b.startSec]));
  return {
    title: String(video.title ?? video.topic ?? 'Untitled'),
    totalSec: timeline.totalMs / 1000,
    beats,
    chapters: (sj.sections?.sections ?? [])
      .filter((s) => s.start_beat > 0 && startOf.has(s.start_beat))
      .map((s) => ({ atSec: startOf.get(s.start_beat)!, title: s.title })),
    endScreenSec: (timeline.endScreenMs ?? 0) / 1000,
    // Captions are burned in only when a caption style is chosen (off by default)
    captions: isCaptionPreset(sj.captions?.preset),
  };
}

/** A small copy for watching: 720p (360p was too soft to read captions, so they were misread as typos), 5 frames a second (Gemini looks at about one), mono sound. */
async function makeWatchCopy(videoPath: string, outPath: string): Promise<void> {
  await execFileAsync(getFfmpegPath(), [
    '-y', '-v', 'error', '-i', videoPath,
    '-vf', 'scale=-2:720,fps=5', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart', outPath,
  ], { maxBuffer: 16 * 1024 * 1024 });
}

/** Gemini's key and the model to watch with (the script stage's writing model when it is Gemini). */
async function watcher(supabase: SupabaseClient): Promise<{ apiKey: string; model: string }> {
  const resolved = await resolveForStage<LLMProvider>('script', supabase).catch(() => null);
  if (resolved && resolved.provider.id.startsWith('gemini') && resolved.ctx.apiKey) {
    const ctx = withWritingModel(resolved.ctx, resolved.options);
    return { apiKey: ctx.apiKey, model: ctx.model || 'gemini-3.5-flash' };
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('The watch-through needs Gemini: set GEMINI_API_KEY.');
  return { apiKey, model: 'gemini-3.5-flash' };
}

async function uploadAndWait(files: GoogleAIFileManager, filePath: string, displayName: string) {
  const { file } = await files.uploadFile(filePath, { mimeType: 'video/mp4', displayName });
  const deadline = Date.now() + 10 * 60 * 1000;
  let current = file;
  while (current.state === FileState.PROCESSING) {
    if (Date.now() > deadline) throw new Error('Gemini took too long to take in the video');
    await new Promise((r) => setTimeout(r, 4000));
    current = await files.getFile(file.name);
  }
  if (current.state !== FileState.ACTIVE) throw new Error('Gemini could not read the video');
  return current;
}

async function runWatch(supabase: SupabaseClient, videoId: string, status: WatchStatus): Promise<void> {
  const copy = path.join(rendersDir(videoId), 'watch-copy.mp4');
  let uploaded: string | null = null;
  let files: GoogleAIFileManager | null = null;
  try {
    const context = await loadWatchContext(supabase, videoId);
    await makeWatchCopy(finalVideoPath(videoId), copy);
    const { apiKey, model } = await watcher(supabase);
    status = await writeWatchStatus(videoId, { ...status, state: 'uploading', model });
    files = new GoogleAIFileManager(apiKey);
    const file = await uploadAndWait(files, copy, `watch-${videoId}`);
    uploaded = file.name;
    status = await writeWatchStatus(videoId, { ...status, state: 'watching' });
    const { data } = await geminiLlm.generateJson(
      {
        system: 'You are a meticulous video editor. You report only problems you actually saw or heard, at the second they happen.',
        prompt: buildWatchPrompt(context),
        schema: WatchSchema,
        files: [{ mimeType: 'video/mp4', uri: file.uri }],
        maxTokens: 8000,
      },
      { apiKey, model, options: {} },
    );
    const notes = normalizeWatchNotes(data.notes, context);
    await replaceAiNotes(supabase, videoId, notes);
    await writeWatchStatus(videoId, { ...status, state: 'done', finishedAt: new Date().toISOString(), notes: notes.length, summary: data.overall.trim().slice(0, 600) });
  } catch (err) {
    console.warn('[WatchThrough] Failed:', err);
    await writeWatchStatus(videoId, { ...status, state: 'failed', finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
  } finally {
    if (files && uploaded) await files.deleteFile(uploaded).catch(() => {});
    await fs.rm(copy, { force: true }).catch(() => {});
  }
}

/** Starts a watch-through in the background; refuses while one is running or before a render exists. */
export async function startWatchThrough(supabase: SupabaseClient, videoId: string): Promise<WatchStatus> {
  if (isWatching(await readWatchStatus(videoId))) throw new Error('The AI is already watching this video.');
  const render = await fs.stat(finalVideoPath(videoId)).catch(() => null);
  if (!render) throw new Error('Render the video first: there is no finished video to watch.');
  await loadWatchContext(supabase, videoId);
  const now = new Date().toISOString();
  const status = await writeWatchStatus(videoId, { state: 'preparing', startedAt: now, updatedAt: now, renderedAt: render.mtime.toISOString() });
  void runWatch(supabase, videoId, status);
  return status;
}
