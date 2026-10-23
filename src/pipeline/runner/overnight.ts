import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkAssemblyGate } from '../assembly/gate';
import { beatsToScenes } from '../utils/mapper';

/**
 * The overnight queue: renders put aside during the day and started by the worker once the night
 * window opens, so a slow laptop stays usable while you work. Held renders live in a small file
 * next to the renders (not in yt_jobs, where the worker would claim them at once); at night each
 * becomes an ordinary assembly job and the worker runs them one after another.
 */

export interface OvernightItem {
  videoId: string;
  title: string;
  addedAt: string;
  /** Why it could not be started last time (it stays in the queue). */
  lastError?: string | null;
  /** When it last failed to start: it waits a while before the next try. */
  triedAt?: string | null;
}

export interface OvernightQueue {
  /** Local times, "HH:MM". The window may cross midnight. */
  window: { start: string; end: string };
  items: OvernightItem[];
}

/** A held render that failed to start is tried again after this long (so not every minute all night). */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const DEFAULT_WINDOW = { start: '23:00', end: '07:00' };

export function overnightQueueFile(): string {
  return process.env.OVERNIGHT_QUEUE_FILE || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'overnight', 'queue.json');
}

const validTime = (t: unknown): t is string => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

export async function readOvernightQueue(): Promise<OvernightQueue> {
  try {
    const raw = JSON.parse(await fs.readFile(overnightQueueFile(), 'utf-8')) as Partial<OvernightQueue>;
    return {
      window: validTime(raw.window?.start) && validTime(raw.window?.end) ? { start: raw.window.start, end: raw.window.end } : { ...DEFAULT_WINDOW },
      items: Array.isArray(raw.items) ? raw.items.filter((i) => i && typeof i.videoId === 'string') : [],
    };
  } catch {
    return { window: { ...DEFAULT_WINDOW }, items: [] };
  }
}

async function writeOvernightQueue(queue: OvernightQueue): Promise<void> {
  const file = overnightQueueFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(queue, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Whether `now` (local time) is inside the window; a window like 23:00–07:00 crosses midnight. */
export function inOvernightWindow(now: Date, window: { start: string; end: string }): boolean {
  const m = now.getHours() * 60 + now.getMinutes();
  const start = minutes(window.start);
  const end = minutes(window.end);
  if (start === end) return true;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export async function setOvernightWindow(start: string, end: string): Promise<OvernightQueue> {
  if (!validTime(start) || !validTime(end)) throw new Error('Times are HH:MM, like 23:00');
  const queue = await readOvernightQueue();
  queue.window = { start, end };
  await writeOvernightQueue(queue);
  return queue;
}

export async function addToOvernightQueue(videoId: string, title: string): Promise<OvernightQueue> {
  const queue = await readOvernightQueue();
  if (!queue.items.some((i) => i.videoId === videoId)) {
    queue.items.push({ videoId, title, addedAt: new Date().toISOString(), lastError: null });
    await writeOvernightQueue(queue);
  }
  return queue;
}

export async function removeFromOvernightQueue(videoId: string): Promise<OvernightQueue> {
  const queue = await readOvernightQueue();
  queue.items = queue.items.filter((i) => i.videoId !== videoId);
  await writeOvernightQueue(queue);
  return queue;
}

export type QueueAssemblyResult =
  | { ok: true; jobId: string }
  | { ok: false; status: number; error: string; missingBeats?: number[]; totalBeats?: number };

/** Queues an assembly job for a video (the Start Assembly button, and the overnight queue at night). */
export async function queueAssemblyJob(
  supabase: SupabaseClient,
  id: string,
  options: { draft?: boolean } = {},
): Promise<QueueAssemblyResult> {
  // Every beat needs an asset before assembly can start
  const gate = await checkAssemblyGate(supabase, id);
  if (!gate.ready) {
    return { ok: false, status: gate.status, error: gate.error ?? 'Not ready to assemble', missingBeats: gate.missingBeats, totalBeats: gate.totalBeats };
  }

  const { data: video } = await supabase.from('videos').select('*').eq('id', id).single();
  if (!video) return { ok: false, status: 404, error: 'Video not found' };

  const { scenes, scriptFingerprint } = beatsToScenes(video.script_json?.beats || []);
  const draft = options.draft === true;
  const { data: newJob, error: jobError } = await supabase
    .from('yt_jobs')
    .insert({
      video_id: id,
      topic: video.topic || video.title || 'Untitled',
      template: video.style || 'tech-explainer',
      status: 'queued',
      stages: ['assembly'],
      script: {
        title: video.title,
        visual_style: video.style,
        scenes,
        ...(draft ? { draft: true } : {}),
      },
      script_fingerprint: scriptFingerprint,
    })
    .select()
    .single();
  if (jobError) return { ok: false, status: 500, error: `Failed to create assembly job: ${jobError.message}` };

  // A quick preview leaves the video's status and finished render as they are
  if (!draft) {
    await supabase.from('videos').update({ status: 'rendering', error_message: null }).eq('id', id);
  }
  return { ok: true, jobId: newJob.id };
}

/**
 * Starts the held renders when the window is open (or at once with `force`). Each that starts
 * leaves the queue; one that cannot (a beat lost its asset, say) stays, with the reason.
 */
export async function releaseOvernightQueue(
  supabase: SupabaseClient,
  options: { now?: Date; force?: boolean } = {},
): Promise<{ started: string[]; failed: string[] }> {
  const queue = await readOvernightQueue();
  const result = { started: [] as string[], failed: [] as string[] };
  if (queue.items.length === 0) return result;
  if (!options.force && !inOvernightWindow(options.now ?? new Date(), queue.window)) return result;

  const remaining: OvernightItem[] = [];
  const now = (options.now ?? new Date()).getTime();
  for (const item of queue.items) {
    if (!options.force && item.triedAt && now - Date.parse(item.triedAt) < RETRY_AFTER_MS) {
      remaining.push(item);
      continue;
    }
    const res = await queueAssemblyJob(supabase, item.videoId).catch(
      (err): QueueAssemblyResult => ({ ok: false, status: 500, error: err instanceof Error ? err.message : String(err) }),
    );
    if (res.ok) {
      result.started.push(item.videoId);
    } else {
      result.failed.push(item.videoId);
      remaining.push({ ...item, lastError: res.error, triedAt: new Date(now).toISOString() });
    }
  }
  // Re-read, so a video added while these were starting is kept
  const latest = await readOvernightQueue();
  latest.items = [
    ...remaining,
    ...latest.items.filter((i) => !queue.items.some((q) => q.videoId === i.videoId)),
  ];
  await writeOvernightQueue(latest);
  return result;
}
