import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Review notes pinned to moments of the video ("the map is too fast here"), shown as markers on
 * Vibedit's scrubber and ticked off when dealt with. Kept with the script (script_json.review_notes).
 */
export interface ReviewNote {
  id: string;
  /** Seconds into the master video. */
  atSec: number;
  /** The beat playing at that moment. */
  beat: number;
  text: string;
  createdAt: string;
  resolved: boolean;
}

async function load(supabase: SupabaseClient, videoId: string) {
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  if (!video) throw new Error('Video not found');
  const sj = (video.script_json ?? {}) as Record<string, unknown> & { review_notes?: ReviewNote[] };
  return { sj, notes: Array.isArray(sj.review_notes) ? sj.review_notes : [] };
}

async function save(supabase: SupabaseClient, videoId: string, sj: Record<string, unknown>, notes: ReviewNote[]): Promise<ReviewNote[]> {
  const sorted = [...notes].sort((a, b) => a.atSec - b.atSec);
  await supabase.from('videos').update({ script_json: { ...sj, review_notes: sorted } }).eq('id', videoId);
  return sorted;
}

export async function listReviewNotes(supabase: SupabaseClient, videoId: string): Promise<ReviewNote[]> {
  return [...(await load(supabase, videoId)).notes].sort((a, b) => a.atSec - b.atSec);
}

export async function addReviewNote(supabase: SupabaseClient, videoId: string, input: { atSec: unknown; beat: unknown; text: unknown }): Promise<ReviewNote[]> {
  const text = typeof input.text === 'string' ? input.text.trim().slice(0, 500) : '';
  const atSec = Number(input.atSec);
  const beat = Number(input.beat);
  if (!text) throw new Error('Write the note first');
  if (!Number.isFinite(atSec) || atSec < 0 || !Number.isInteger(beat) || beat < 0) throw new Error('Invalid moment');
  const { sj, notes } = await load(supabase, videoId);
  if (notes.length >= 300) throw new Error('Too many notes; resolve or delete some first');
  const note: ReviewNote = { id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, atSec: Math.round(atSec * 10) / 10, beat, text, createdAt: new Date().toISOString(), resolved: false };
  return save(supabase, videoId, sj, [...notes, note]);
}

export async function updateReviewNote(supabase: SupabaseClient, videoId: string, id: string, patch: { resolved?: unknown; text?: unknown }): Promise<ReviewNote[]> {
  const { sj, notes } = await load(supabase, videoId);
  if (!notes.some((n) => n.id === id)) throw new Error('That note is gone');
  return save(
    supabase,
    videoId,
    sj,
    notes.map((n) =>
      n.id === id
        ? {
            ...n,
            ...(typeof patch.resolved === 'boolean' ? { resolved: patch.resolved } : {}),
            ...(typeof patch.text === 'string' && patch.text.trim() ? { text: patch.text.trim().slice(0, 500) } : {}),
          }
        : n,
    ),
  );
}

export async function deleteReviewNote(supabase: SupabaseClient, videoId: string, id: string): Promise<ReviewNote[]> {
  const { sj, notes } = await load(supabase, videoId);
  return save(supabase, videoId, sj, notes.filter((n) => n.id !== id));
}
