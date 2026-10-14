import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { invalidateBeatAssemblyCache } from '../utils/media-upload';
import { concatClips } from './clips';
import { upsertVideoAssetProvenance } from './provenance';
import { summarizeLicenses, type ComposedShot, type RenderedShot, type ShotSlot } from './shot-composer';

/**
 * Edits a composed beat one shot at a time: a shot is re-rendered at exactly its original length,
 * so the beat is re-joined from its clips (stream copy, seconds) and every other cut stays in sync
 * with the narration.
 */

export interface ComposedBeatRecord {
  beatIndex: number;
  trackPath: string;
  shots: ComposedShot[];
}

export const sidecarPath = (trackPath: string) => `${trackPath}.shots.json`;

/** Where the shot clips of a composed track live (written by composeBeatTrack). */
export const shotClipPath = (trackPath: string, beatIndex: number, shotIndex: number) =>
  path.join(path.dirname(trackPath), `beat_${beatIndex}_shots`, `shot_${shotIndex}.mp4`);

/** A shot as sent to the browser: no local file paths. */
export function publicShot(shot: ComposedShot, index: number): Omit<ComposedShot, 'clipPath'> & { index: number } {
  const out: Partial<ComposedShot> & { index: number } = { ...shot, index };
  delete out.clipPath;
  return out as Omit<ComposedShot, 'clipPath'> & { index: number };
}

const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.join(process.cwd(), p));

/** The composed track recorded for a beat, or null when the beat isn't composed from shots. */
export async function loadComposedBeat(
  supabase: SupabaseClient,
  videoId: string,
  beatIndex: number,
): Promise<ComposedBeatRecord | null> {
  const { data: asset } = await supabase
    .from('video_assets')
    .select('visual_type, source_url')
    .eq('video_id', videoId)
    .eq('beat_index', beatIndex)
    .maybeSingle();
  if (asset?.visual_type !== 'composite' || !asset.source_url) return null;
  const trackPath = resolvePath(asset.source_url);
  try {
    const sidecar = JSON.parse(await fs.readFile(sidecarPath(trackPath), 'utf-8')) as { beatIndex: number; shots: ComposedShot[] };
    // Sidecars written before shot editing existed lack the plan; those beats can't be edited
    if (!sidecar.shots.every((s) => s.plan && Number.isInteger(s.frames))) return null;
    return { beatIndex, trackPath, shots: sidecar.shots };
  } catch {
    return null;
  }
}

/**
 * Replaces one shot: renders it (to a temporary file, so a failure leaves the beat untouched),
 * swaps it in, re-joins the track, rewrites the sidecar, and refreshes the beat's credits and
 * assembly cache.
 */
export async function replaceShot(options: {
  supabase: SupabaseClient;
  videoId: string;
  beat: ComposedBeatRecord;
  shotIndex: number;
  render: (slot: ShotSlot, clipPath: string) => Promise<RenderedShot>;
}): Promise<ComposedShot> {
  const { supabase, videoId, beat, shotIndex, render } = options;
  const current = beat.shots[shotIndex];
  if (!current) throw new Error(`Beat ${beat.beatIndex} has no shot ${shotIndex}`);

  const clipPath = shotClipPath(beat.trackPath, beat.beatIndex, shotIndex);
  const tempPath = clipPath.replace(/\.mp4$/, '.new.mp4');
  const slot: ShotSlot = { shot: current.plan, startSec: current.startSec, frames: current.frames };
  let rendered: RenderedShot;
  try {
    rendered = await render(slot, tempPath);
    await fs.rename(rendered.clipPath, clipPath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }

  const updated: ComposedShot = {
    ...rendered,
    clipPath,
    // Alternatives stay on offer after a swap: the old pick joins them, the new one leaves
    alternatives: rendered.alternatives ?? current.alternatives,
    plannedType: current.plannedType,
    startSec: current.startSec,
    durationSec: current.durationSec,
    frames: current.frames,
    plan: current.plan,
  };
  const shots = beat.shots.map((s, i) => (i === shotIndex ? updated : s));
  const clips = shots.map((_, i) => shotClipPath(beat.trackPath, beat.beatIndex, i));
  await concatClips(clips, beat.trackPath);
  await fs.writeFile(sidecarPath(beat.trackPath), JSON.stringify({ beatIndex: beat.beatIndex, shots }, null, 2), 'utf-8');

  const { license, attribution, sources } = summarizeLicenses(shots);
  await upsertVideoAssetProvenance(supabase, {
    video_id: videoId,
    beat_index: beat.beatIndex,
    visual_type: 'composite',
    source_url: beat.trackPath,
    license_type: license,
    license_source: sources.length ? `${sources.length} source${sources.length === 1 ? '' : 's'}` : 'generated',
    attribution_text: attribution,
    license_proof_url: sources[0] ?? null,
    candidates_json: null,
  });
  await invalidateBeatAssemblyCache(supabase, videoId, beat.beatIndex);
  beat.shots = shots;
  return updated;
}
