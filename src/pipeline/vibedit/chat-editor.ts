import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '../providers/registry';
import type { LLMProvider } from '../providers/types';
import { kindOf } from '@/lib/script/visual-rhythm';
import { loadComposedBeat, shotClipPath, sidecarPath, type ComposedBeatRecord } from '../visuals/shot-editor';
import { editShot, type ShotEdit } from '../visuals/shot-editor-actions';
import { shotNeedsCheck } from '../visuals/shot-composer';
import { invalidateBeatAssemblyCache } from '../utils/media-upload';
import { rendersDir } from '../publish/publish-assets';

/**
 * The Vibedit chat editor (visuals): a request in plain words ("replace the text cards in chapter
 * 2 with footage", "find a better shot for beat 12", "use old film of the docks here") becomes an
 * exact list of shot changes for the creator to confirm. Applying it snapshots every beat it
 * touches first, so Undo puts the beats back as they were.
 */

export type ChatAction = 'footage' | 'redo' | 'text';

export interface ChatChange {
  beat: number;
  shot: number;
  action: ChatAction;
  /** For footage: what to search for. */
  query?: string;
  /** For footage: old archive photos and film rather than modern stock. */
  archive?: boolean;
  /** One line on why, shown in the plan. */
  reason: string;
  /** What the shot shows now (filled in from the video, not the model). */
  now?: string;
}

export interface ChatPlan {
  reply: string;
  changes: ChatChange[];
}

/** At most this many shots per request: each can take a minute to search, check and render. */
export const MAX_CHANGES = 12;

interface ContextShot {
  shot: number;
  type: string;
  kind: string;
  shows: string;
  /** The shot's current search (to tell a new search from the same one). */
  query: string;
  covers: string;
  seconds: number;
  flagged: boolean;
}

export interface EditContext {
  style: string | null;
  beats: Array<{ beat: number; chapter: number; chapterTitle: string; atSec: number | null; text: string; shots: ContextShot[] | null }>;
}

const describe = (shot: ComposedBeatRecord['shots'][number]) =>
  (shot.plan?.title_card?.text || shot.plan?.quote?.text || shot.plan?.stat?.label || shot.plan?.visual_query || shot.renderedType).slice(0, 90);

/** The video as the model sees it: chapters, beats, narration, and every editable shot. */
export async function buildEditContext(supabase: SupabaseClient, videoId: string): Promise<EditContext> {
  const { data: video } = await supabase.from('videos').select('style, script_json').eq('id', videoId).maybeSingle();
  if (!video) throw new Error('Video not found');
  const sj = (video.script_json ?? {}) as {
    beats?: Array<{ text?: string }>;
    sections?: { sections?: Array<{ start_beat: number; title: string }> };
    timeline?: { beats?: Array<{ index: number; sceneStartMs: number }> };
  };
  const beats = sj.beats ?? [];
  const sections = [...(sj.sections?.sections ?? [])].sort((a, b) => a.start_beat - b.start_beat);
  const starts = new Map((sj.timeline?.beats ?? []).map((b) => [b.index, b.sceneStartMs / 1000]));
  const out: EditContext = { style: video.style ?? null, beats: [] };
  for (let i = 0; i < beats.length; i++) {
    const chapterIndex = sections.filter((s) => s.start_beat <= i).length - 1;
    const composed = await loadComposedBeat(supabase, videoId, i).catch(() => null);
    out.beats.push({
      beat: i,
      chapter: Math.max(1, chapterIndex + 1),
      chapterTitle: sections[chapterIndex]?.title ?? '',
      atSec: starts.get(i) ?? null,
      text: String(beats[i]?.text ?? ''),
      shots: composed
        ? composed.shots.map((s, n) => ({
            shot: n,
            type: s.renderedType,
            kind: kindOf(s.renderedType),
            shows: describe(s),
            query: s.plan?.visual_query ?? '',
            covers: (s.plan?.covers ?? '').slice(0, 120),
            seconds: Math.round(s.durationSec * 10) / 10,
            flagged: Boolean(s.fallback) || s.renderedType === 'color' || shotNeedsCheck(s),
          }))
        : null,
    });
  }
  return out;
}

const time = (sec: number | null) => (sec === null ? '' : ` at ${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`);

export function buildPlanPrompt(context: EditContext, request: string, history: Array<{ role: 'user' | 'assistant'; text: string }>): string {
  const lines = context.beats.map((b) => {
    const head = `Beat ${b.beat + 1} (chapter ${b.chapter}${b.chapterTitle ? ` "${b.chapterTitle}"` : ''}${time(b.atSec)}): ${b.text}`;
    if (!b.shots) return `${head}\n  (one visual, not editable here)`;
    return `${head}\n${b.shots
      .map((s) => `  shot ${s.shot + 1}: ${s.type} (${s.kind}, ${s.seconds}s)${s.flagged ? ' [FLAGGED: fallback or unchecked]' : ''} shows "${s.shows}" under "${s.covers}"`)
      .join('\n')}`;
  });
  const convo = history.slice(-6).map((h) => `${h.role === 'user' ? 'Creator' : 'You'}: ${h.text}`).join('\n');
  return `You edit the visuals of a ${context.style ?? 'documentary'} YouTube video for its creator. Turn the request into shot changes.

The video, beat by beat (beats, shots and chapters are numbered from 1, as the creator sees them; times are where the beat starts):
${lines.join('\n')}

${convo ? `Conversation so far:\n${convo}\n\n` : ''}Request: ${request}

Actions, one per shot:
- "footage": new real footage for "query": 3-8 concrete, filmable words of what to show, matching the narration the shot plays under (e.g. "container ship entering port at dusk"). Set "archive": true for old photos or film (history, events before about 1990); otherwise modern stock. This also turns a chart, map, card or text into footage.
- "redo": pick again with the same idea (a better take of the same thing; graphics are re-rendered).
- "text": show the narration as animated type.

Rules:
- Only shots listed above. Never invent beats or shots. "Chapter 2" means every beat in chapter 2; "text cards" are kinetic_text and title shots; "graphics" are charts, stats, maps and other non-footage.
- Only change what was asked. At most ${MAX_CHANGES} changes; if more match, take the first ${MAX_CHANGES} and say so in the reply.
- Footage must show what the narration says. No named people or brands in a query unless the narration names them.
- You change pictures only. A request about music, sound, narration, voice, length or pace ("darker music", "shorter intro") is NOT a visuals request even if pictures could be changed to match it: return no changes and say in the reply that this editor changes the pictures, and that music, sound and narration are set elsewhere for now.
- If nothing matches, return no changes and say so.
- "reply": one or two plain sentences about what you WILL change (nothing is changed until the creator confirms), e.g. "I'll swap the two text cards in chapter 2 for footage."
- "reason": a few words per change.`;
}

const PlanSchema = z.object({
  reply: z.string(),
  changes: z.array(
    z.object({
      beat: z.number(),
      shot: z.number(),
      action: z.enum(['footage', 'redo', 'text']),
      query: z.string().nullable().optional(),
      archive: z.boolean().nullable().optional(),
      reason: z.string().nullable().optional(),
    }),
  ),
});

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
/** Two searches that share nearly all their words are the same search. */
export function sameSearch(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return x.size + y.size > 0 && shared / (x.size + y.size - shared) >= 0.8;
}

/**
 * What the request names outright, enforced in code: "chapter 2" keeps changes in chapter 2,
 * "beat 12" (or "beats 3 and 5") keeps those beats, "text cards" keeps text shots.
 * Numbers are as the creator sees them (from 1); the result is the video's (from 0).
 */
export function requestScope(request: string): { chapters?: Set<number>; beats?: Set<number>; textOnly?: boolean } {
  const scope: { chapters?: Set<number>; beats?: Set<number>; textOnly?: boolean } = {};
  const numbersAfter = (word: string) => {
    const out = new Set<number>();
    for (const m of request.matchAll(new RegExp(`\\b${word}s?\\s+((?:\\d+(?:\\s*(?:,|and|&|-|to)\\s*)?)+)`, 'gi'))) {
      const list = m[1];
      for (const r of list.matchAll(/(\d+)\s*(?:-|to)\s*(\d+)/g)) for (let n = Number(r[1]); n <= Number(r[2]) && n - Number(r[1]) < 200; n++) out.add(n);
      for (const n of list.match(/\d+/g) ?? []) out.add(Number(n));
    }
    return out;
  };
  const chapters = numbersAfter('chapter');
  if (chapters.size) scope.chapters = chapters;
  const beats = numbersAfter('beat');
  if (beats.size) scope.beats = new Set([...beats].map((n) => n - 1));
  if (/\btext[ -]?cards?\b/i.test(request)) scope.textOnly = true;
  return scope;
}

/** Keeps only changes to shots that exist, once each, footage with a query, within the cap. */
export function normalizePlan(raw: z.infer<typeof PlanSchema>, context: EditContext, request = ''): ChatPlan {
  const scope = requestScope(request);
  const seen = new Set<string>();
  const changes: ChatChange[] = [];
  for (const c of raw.changes) {
    const beat = context.beats[c.beat];
    const shot = beat?.shots?.[c.shot];
    if (!shot) continue;
    if (scope.chapters && !scope.chapters.has(beat.chapter)) continue;
    if (scope.beats && !scope.beats.has(c.beat)) continue;
    if (scope.textOnly && shot.kind !== 'text') continue;
    const key = `${c.beat}:${c.shot}`;
    if (seen.has(key)) continue;
    const query = (c.query ?? '').trim().slice(0, 200);
    if (c.action === 'footage' && !query) continue;
    // Footage searched the same way is a fresh pick of the same shot
    const action = c.action === 'footage' && shot.kind === 'footage' && sameSearch(query, shot.query) ? 'redo' : c.action;
    seen.add(key);
    changes.push({
      beat: c.beat,
      shot: c.shot,
      action,
      ...(action === 'footage' ? { query, archive: Boolean(c.archive) } : {}),
      reason: (c.reason ?? '').trim().slice(0, 140),
      now: `${shot.type}: ${shot.shows}`,
    });
    if (changes.length >= MAX_CHANGES) break;
  }
  return { reply: raw.reply.trim().slice(0, 600) || (changes.length ? 'Here is what I would change.' : 'I found nothing to change.'), changes };
}

export async function planChatEdit(
  supabase: SupabaseClient,
  videoId: string,
  request: string,
  history: Array<{ role: 'user' | 'assistant'; text: string }> = [],
): Promise<ChatPlan> {
  const context = await buildEditContext(supabase, videoId);
  if (!context.beats.some((b) => b.shots?.length)) {
    return { reply: 'This video has no shot-by-shot beats to edit yet. Source its visuals first.', changes: [] };
  }
  const { provider, ctx } = await resolveForStage<LLMProvider>('script', supabase);
  const { data } = await provider.generateJson(
    {
      system: 'You are a careful video editor. You change only what the creator asks, and only shots that exist.',
      prompt: buildPlanPrompt(context, request.trim().slice(0, 1000), history),
      schema: PlanSchema,
    },
    ctx,
  );
  // The model counts from 1, like the creator; the video counts from 0
  return normalizePlan({ ...data, changes: data.changes.map((c) => ({ ...c, beat: c.beat - 1, shot: c.shot - 1 })) }, context, request);
}

// ---- Snapshots and undo ----

export const snapshotsDir = (videoId: string) => path.join(rendersDir(videoId), 'vibedit-snapshots');
const beatShotsDir = (trackPath: string, beatIndex: number) => path.dirname(shotClipPath(trackPath, beatIndex, 0));

interface SnapshotBeat {
  beatIndex: number;
  trackPath: string;
  asset: Record<string, unknown> | null;
}

export interface SnapshotInfo {
  id: string;
  createdAt: string;
  label: string;
  beats: number[];
}

/** Copies each beat's track, shot record and shot clips aside, with its asset row. */
export async function snapshotBeats(supabase: SupabaseClient, videoId: string, beatIndexes: number[], label: string): Promise<string> {
  const id = `${Date.now()}`;
  const dir = path.join(snapshotsDir(videoId), id);
  const saved: SnapshotBeat[] = [];
  for (const beatIndex of [...new Set(beatIndexes)].sort((a, b) => a - b)) {
    const beat = await loadComposedBeat(supabase, videoId, beatIndex);
    if (!beat) continue;
    const to = path.join(dir, `beat_${beatIndex}`);
    await fs.mkdir(to, { recursive: true });
    await fs.copyFile(beat.trackPath, path.join(to, 'track.mp4'));
    await fs.copyFile(sidecarPath(beat.trackPath), path.join(to, 'track.shots.json'));
    await fs.cp(beatShotsDir(beat.trackPath, beatIndex), path.join(to, 'shots'), { recursive: true });
    const { data: asset } = await supabase.from('video_assets').select('*').eq('video_id', videoId).eq('beat_index', beatIndex).maybeSingle();
    saved.push({ beatIndex, trackPath: beat.trackPath, asset: asset ?? null });
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'snapshot.json'),
    JSON.stringify({ id, createdAt: new Date().toISOString(), label: label.slice(0, 200), beats: saved }, null, 2),
    'utf-8',
  );
  return id;
}

export async function listSnapshots(videoId: string): Promise<SnapshotInfo[]> {
  const ids = await fs.readdir(snapshotsDir(videoId)).catch(() => [] as string[]);
  const out: SnapshotInfo[] = [];
  for (const id of ids) {
    try {
      const s = JSON.parse(await fs.readFile(path.join(snapshotsDir(videoId), id, 'snapshot.json'), 'utf-8'));
      out.push({ id: s.id, createdAt: s.createdAt, label: s.label, beats: s.beats.map((b: SnapshotBeat) => b.beatIndex) });
    } catch {
      // a half-written snapshot is skipped
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/** Puts the snapshot's beats back exactly as they were, then removes the snapshot. */
export async function restoreSnapshot(supabase: SupabaseClient, videoId: string, snapshotId: string): Promise<number[]> {
  if (!/^\d+$/.test(snapshotId)) throw new Error('Invalid snapshot');
  const dir = path.join(snapshotsDir(videoId), snapshotId);
  const snap = JSON.parse(await fs.readFile(path.join(dir, 'snapshot.json'), 'utf-8').catch(() => {
    throw new Error('That change can no longer be undone');
  })) as { beats: SnapshotBeat[] };
  for (const b of snap.beats) {
    const from = path.join(dir, `beat_${b.beatIndex}`);
    const shotsDir = beatShotsDir(b.trackPath, b.beatIndex);
    await fs.rm(shotsDir, { recursive: true, force: true });
    await fs.cp(path.join(from, 'shots'), shotsDir, { recursive: true });
    await fs.copyFile(path.join(from, 'track.mp4'), b.trackPath);
    await fs.copyFile(path.join(from, 'track.shots.json'), sidecarPath(b.trackPath));
    if (b.asset) {
      const { id: _id, ...row } = b.asset as { id?: unknown } & Record<string, unknown>;
      void _id;
      await supabase.from('video_assets').update(row).eq('video_id', videoId).eq('beat_index', b.beatIndex);
    }
    await invalidateBeatAssemblyCache(supabase, videoId, b.beatIndex);
  }
  await fs.rm(dir, { recursive: true, force: true });
  return snap.beats.map((b) => b.beatIndex);
}

// ---- Applying ----

export interface ChangeResult {
  beat: number;
  shot: number;
  ok: boolean;
  shows?: string;
  error?: string;
}

/**
 * Applies a confirmed plan, one shot at a time (a failed shot is left as it was and reported).
 * The snapshot is taken first; its id undoes the whole request.
 */
export async function applyChatPlan(
  supabase: SupabaseClient,
  videoId: string,
  changes: ChatChange[],
  label: string,
  options: { edit?: typeof editShot; max?: number; onProgress?: (results: ChangeResult[], total: number) => void | Promise<void> } = {},
): Promise<{ snapshotId: string; results: ChangeResult[] }> {
  const edit = options.edit ?? editShot;
  const list = changes.slice(0, options.max ?? MAX_CHANGES);
  const snapshotId = await snapshotBeats(supabase, videoId, list.map((c) => c.beat), label);
  const results: ChangeResult[] = [];
  for (const c of list) {
    try {
      // Reloaded per change: an earlier change to the same beat rewrote its record
      const beat = await loadComposedBeat(supabase, videoId, c.beat);
      if (!beat?.shots[c.shot]) throw new Error('That shot is no longer there');
      const shotEdit: ShotEdit =
        c.action === 'footage' ? { action: 'footage', query: c.query ?? '', archive: c.archive } : c.action === 'text' ? { action: 'text' } : { action: 'redo' };
      const shot = await edit({ supabase, videoId, beat, shotIndex: c.shot, edit: shotEdit });
      results.push({ beat: c.beat, shot: c.shot, ok: true, shows: `${shot.renderedType}${shot.note ? ` (${shot.note})` : ''}` });
    } catch (err) {
      results.push({ beat: c.beat, shot: c.shot, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
    await options.onProgress?.(results, list.length);
  }
  return { snapshotId, results };
}
