import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_OVERLAYS, normalizeOverlay, readOverlays, type Overlay } from '../assembly/overlays';

/** The creator's text, callouts and arrows (script_json.overlays), kept in video order. */
async function load(supabase: SupabaseClient, videoId: string) {
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  if (!video) throw new Error('Video not found');
  const sj = (video.script_json ?? {}) as Record<string, unknown> & { beats?: unknown[] };
  return { sj, overlays: readOverlays(sj.overlays), beatCount: Array.isArray(sj.beats) ? sj.beats.length : 0 };
}

async function save(supabase: SupabaseClient, videoId: string, sj: Record<string, unknown>, overlays: Overlay[]): Promise<Overlay[]> {
  const sorted = [...overlays].sort((a, b) => a.beat - b.beat || a.offsetSec - b.offsetSec);
  await supabase.from('videos').update({ script_json: { ...sj, overlays: sorted } }).eq('id', videoId);
  return sorted;
}

export async function listOverlays(supabase: SupabaseClient, videoId: string): Promise<Overlay[]> {
  return (await load(supabase, videoId)).overlays;
}

export async function addOverlay(supabase: SupabaseClient, videoId: string, raw: unknown): Promise<Overlay[]> {
  const { sj, overlays, beatCount } = await load(supabase, videoId);
  const overlay = normalizeOverlay({ ...(raw as object), id: undefined });
  if (!overlay) throw new Error('Give the overlay its words, its moment and its place');
  if (overlay.beat >= beatCount) throw new Error(`Beat ${overlay.beat + 1} does not exist`);
  if (overlays.length >= MAX_OVERLAYS) throw new Error('Too many overlays');
  return save(supabase, videoId, sj, [...overlays, overlay]);
}

export async function updateOverlay(supabase: SupabaseClient, videoId: string, id: string, raw: unknown): Promise<Overlay[]> {
  const { sj, overlays } = await load(supabase, videoId);
  const current = overlays.find((o) => o.id === id);
  if (!current) throw new Error('That overlay is gone');
  const updated = normalizeOverlay({ ...current, ...(raw as object) }, id);
  if (!updated) throw new Error('Invalid overlay');
  return save(supabase, videoId, sj, overlays.map((o) => (o.id === id ? updated : o)));
}

export async function deleteOverlay(supabase: SupabaseClient, videoId: string, id: string): Promise<Overlay[]> {
  const { sj, overlays } = await load(supabase, videoId);
  return save(supabase, videoId, sj, overlays.filter((o) => o.id !== id));
}
