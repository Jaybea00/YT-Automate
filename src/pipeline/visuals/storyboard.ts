import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getFfmpegPath } from '../utils/ffmpeg';
import { readSidecar, shotClipPath, type ComposedBeatRecord } from './shot-editor';
import type { ComposedShot } from './shot-composer';

const execFileAsync = promisify(execFile);
const FPS = 30;

/**
 * The storyboard: every rendered shot of a video in order, with what it plays under, so the
 * whole video can be reviewed as a sequence (storyboard-review.ts) and fixed shot by shot.
 */

export interface StoryboardShot {
  beatIndex: number;
  shotIndex: number;
  /** Position in the whole video's shot order. */
  order: number;
  startSec: number;
  durationSec: number;
  renderedType: string;
  plannedType: string;
  covers: string;
  query: string;
  clipPath: string;
  sourceUrl: string | null;
  attribution: string | null;
  still: boolean;
  fallback: boolean;
  needsCheck: boolean;
  note: string | null;
  alternatives: number;
}

export interface Storyboard {
  shots: StoryboardShot[];
  /** Beats that aren't composed from shots (one visual per beat) or not rendered yet. */
  missingBeats: number[];
}

/** Every beat's composed track in one query, read in parallel (null for beats without one). */
async function loadComposedBeats(supabase: SupabaseClient, videoId: string, beatCount: number): Promise<Array<ComposedBeatRecord | null>> {
  const { data: assets } = await supabase.from('video_assets').select('beat_index, visual_type, source_url').eq('video_id', videoId);
  const tracks = new Map((assets ?? []).filter((a) => a.visual_type === 'composite' && a.source_url).map((a) => [a.beat_index as number, a.source_url as string]));
  return Promise.all(
    Array.from({ length: beatCount }, async (_, beatIndex) => {
      const source = tracks.get(beatIndex);
      if (!source) return null;
      const trackPath = path.isAbsolute(source) ? source : path.join(process.cwd(), source);
      const sidecar = await readSidecar(trackPath).catch(() => null);
      if (!sidecar || !sidecar.shots.every((s) => s.plan && Number.isInteger(s.frames))) return null;
      return { beatIndex, trackPath, shots: sidecar.shots, leadInSec: sidecar.leadInSec ?? 0, tailSec: sidecar.tailSec ?? 0 };
    }),
  );
}

export async function loadStoryboard(supabase: SupabaseClient, videoId: string): Promise<Storyboard> {
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  const beatCount = Array.isArray(video?.script_json?.beats) ? video!.script_json.beats.length : 0;
  const beats = await loadComposedBeats(supabase, videoId, beatCount);
  const shots: StoryboardShot[] = [];
  const missingBeats: number[] = [];
  let t = 0;
  for (let beatIndex = 0; beatIndex < beatCount; beatIndex++) {
    const beat = beats[beatIndex];
    if (!beat) {
      missingBeats.push(beatIndex);
      continue;
    }
    t += beat.leadInSec;
    beat.shots.forEach((s: ComposedShot, shotIndex) => {
      const durationSec = s.frames / FPS;
      shots.push({
        beatIndex,
        shotIndex,
        order: shots.length,
        startSec: Math.round(t * 10) / 10,
        durationSec: Math.round(durationSec * 10) / 10,
        renderedType: s.renderedType,
        plannedType: s.plan.visual_type,
        covers: s.plan.covers,
        query: s.plan.visual_query,
        clipPath: shotClipPath(beat.trackPath, beatIndex, shotIndex),
        sourceUrl: s.sourceUrl ?? null,
        attribution: s.attribution ?? null,
        still: Boolean(s.still),
        fallback: Boolean(s.fallback),
        needsCheck: Boolean(s.needsCheck),
        note: s.note ?? null,
        alternatives: s.alternatives?.length ?? 0,
      });
      t += durationSec;
    });
    t += beat.tailSec;
  }
  return { shots, missingBeats };
}

/** The footage sources a video shows (for channel freshness). */
export async function videoFootageSources(supabase: SupabaseClient, videoId: string): Promise<string[]> {
  const { shots } = await loadStoryboard(supabase, videoId);
  return [...new Set(shots.map((s) => s.sourceUrl).filter((u): u is string => Boolean(u)))];
}

/**
 * A still from the middle of a shot's clip, made once and kept beside it (re-made when the clip
 * is newer). Small, for the storyboard grid and the review.
 */
export async function shotThumbnail(clipPath: string): Promise<string> {
  const thumb = `${clipPath}.thumb.jpg`;
  const [clip, existing] = await Promise.all([fs.stat(clipPath), fs.stat(thumb).catch(() => null)]);
  if (existing && existing.mtimeMs >= clip.mtimeMs) return thumb;
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clipPath]).catch(() => ({ stdout: '1' }));
  const mid = Math.max(0, (Number.parseFloat(stdout) || 1) / 2);
  await fs.mkdir(path.dirname(thumb), { recursive: true });
  await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', mid.toFixed(2), '-i', clipPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', thumb]);
  return thumb;
}
