import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '../providers/registry';
import type { LLMProvider } from '../providers/types';
import { rendersDir } from '../publish/publish-assets';
import type { editShot } from '../visuals/shot-editor-actions';
import { applyChatPlan, buildEditContext, type ChatChange, type EditContext } from './chat-editor';

/**
 * Bulk fixes in Vibedit: every flagged shot picked again, or every text card turned into
 * footage, in one go. They run in the background (each shot can take a minute), report progress,
 * and are snapshotted like a chat edit, so one Undo puts everything back.
 */

export type BulkKind = 'flagged' | 'text_cards';

export interface BulkStatus {
  kind: BulkKind;
  state: 'planning' | 'running' | 'done' | 'failed';
  total: number;
  done: number;
  failed: number;
  startedAt: string;
  finishedAt?: string;
  snapshotId?: string;
  error?: string;
  /** Last progress: a run silent for longer than ABANDONED_MS (the server restarted) no longer blocks. */
  updatedAt?: string;
}

const ABANDONED_MS = 15 * 60 * 1000;
export const isActive = (s: BulkStatus | null, now = Date.now()) =>
  Boolean(s) && (s!.state === 'planning' || s!.state === 'running') && now - Date.parse(s!.updatedAt ?? s!.startedAt) < ABANDONED_MS;

/** A bulk run can't change more than this many shots (a long video's worth). */
export const MAX_BULK = 80;

const statusFile = (videoId: string) => path.join(rendersDir(videoId), 'vibedit-bulk.json');

export async function readBulkStatus(videoId: string): Promise<BulkStatus | null> {
  try {
    return JSON.parse(await fs.readFile(statusFile(videoId), 'utf-8')) as BulkStatus;
  } catch {
    return null;
  }
}

async function writeBulkStatus(videoId: string, status: BulkStatus): Promise<void> {
  await fs.mkdir(path.dirname(statusFile(videoId)), { recursive: true });
  status.updatedAt = new Date().toISOString();
  await fs.writeFile(statusFile(videoId), JSON.stringify(status, null, 2), 'utf-8');
}

/** What each bulk fix would change, from the video as it is now. */
export function bulkCounts(context: EditContext): Record<BulkKind, number> {
  let flagged = 0;
  let textCards = 0;
  for (const b of context.beats) {
    for (const s of b.shots ?? []) {
      if (s.flagged) flagged++;
      if (s.kind === 'text') textCards++;
    }
  }
  return { flagged, text_cards: textCards };
}

const QueriesSchema = z.object({
  shots: z.array(z.object({ id: z.string(), query: z.string(), archive: z.boolean().nullable().optional() })),
});

/** Footage searches for text cards, from the narration each one plays under (batched). */
export async function footageQueries(
  supabase: SupabaseClient,
  context: EditContext,
  shots: Array<{ beat: number; shot: number }>,
): Promise<Map<string, { query: string; archive: boolean }>> {
  const { provider, ctx } = await resolveForStage<LLMProvider>('script', supabase);
  const out = new Map<string, { query: string; archive: boolean }>();
  for (let i = 0; i < shots.length; i += 25) {
    const batch = shots.slice(i, i + 25);
    const lines = batch.map(({ beat, shot }) => {
      const b = context.beats[beat];
      const s = b.shots![shot];
      return `${beat}:${shot} | beat narration: ${b.text} | this shot plays under: "${s.covers}" | it shows the text: "${s.shows}"`;
    });
    const { data } = await provider.generateJson(
      {
        system: 'You find real footage for documentary shots.',
        prompt: `A ${context.style ?? 'documentary'} video shows these lines as animated text. Replace each with real footage that shows what is said.

${lines.join('\n')}

For each id, give "query": 3-8 concrete, filmable words of what to show (e.g. "container ship entering port at dusk"), and "archive": true for old photos or film (events before about 1990). No named people or brands unless the narration names them.`,
        schema: QueriesSchema,
      },
      ctx,
    );
    for (const r of data.shots) {
      const query = r.query.trim().slice(0, 200);
      if (query && batch.some((b) => `${b.beat}:${b.shot}` === r.id)) out.set(r.id, { query, archive: Boolean(r.archive) });
    }
  }
  return out;
}

/** The changes a bulk fix makes. */
export async function bulkChanges(supabase: SupabaseClient, context: EditContext, kind: BulkKind): Promise<ChatChange[]> {
  const targets: Array<{ beat: number; shot: number; now: string }> = [];
  for (const b of context.beats) {
    for (const s of b.shots ?? []) {
      if (kind === 'flagged' ? s.flagged : s.kind === 'text') targets.push({ beat: b.beat, shot: s.shot, now: `${s.type}: ${s.shows}` });
    }
  }
  const list = targets.slice(0, MAX_BULK);
  if (kind === 'flagged') return list.map((t) => ({ ...t, action: 'redo' as const, reason: 'flagged' }));
  const queries = await footageQueries(supabase, context, list);
  return list.flatMap((t) => {
    const q = queries.get(`${t.beat}:${t.shot}`);
    return q ? [{ ...t, action: 'footage' as const, query: q.query, archive: q.archive, reason: 'text card to footage' }] : [];
  });
}

/**
 * Starts a bulk fix in the background and returns at once; progress is in readBulkStatus.
 * One at a time per video.
 */
export async function startBulkFix(
  supabase: SupabaseClient,
  videoId: string,
  kind: BulkKind,
  options: { edit?: typeof editShot } = {},
): Promise<{ status: BulkStatus; finished: Promise<void> }> {
  const current = await readBulkStatus(videoId);
  if (isActive(current)) throw new Error('A bulk fix is already running for this video');
  const status: BulkStatus = { kind, state: 'planning', total: 0, done: 0, failed: 0, startedAt: new Date().toISOString() };
  await writeBulkStatus(videoId, status);

  const finished = (async () => {
    try {
      const context = await buildEditContext(supabase, videoId);
      const changes = await bulkChanges(supabase, context, kind);
      Object.assign(status, { state: 'running', total: changes.length });
      await writeBulkStatus(videoId, status);
      if (changes.length === 0) {
        Object.assign(status, { state: 'done', finishedAt: new Date().toISOString() });
        await writeBulkStatus(videoId, status);
        return;
      }
      const label = kind === 'flagged' ? 'Bulk fix: redo every flagged shot' : 'Bulk fix: text cards to footage';
      const { snapshotId, results } = await applyChatPlan(supabase, videoId, changes, label, {
        max: MAX_BULK,
        edit: options.edit,
        onProgress: async (r) => {
          Object.assign(status, { done: r.filter((x) => x.ok).length, failed: r.filter((x) => !x.ok).length });
          await writeBulkStatus(videoId, status);
        },
      });
      Object.assign(status, {
        state: 'done',
        snapshotId,
        done: results.filter((x) => x.ok).length,
        failed: results.filter((x) => !x.ok).length,
        finishedAt: new Date().toISOString(),
      });
      await writeBulkStatus(videoId, status);
    } catch (err) {
      Object.assign(status, { state: 'failed', error: err instanceof Error ? err.message.slice(0, 300) : String(err), finishedAt: new Date().toISOString() });
      await writeBulkStatus(videoId, status).catch(() => {});
    }
  })();
  return { status, finished };
}
