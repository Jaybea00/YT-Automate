import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rendersDir } from '../publish/publish-assets';
import { concatClips } from '../visuals/clips';
import { shotClipPath, sidecarPath } from '../visuals/shot-editor';
import { invalidateBeatAssemblyCache } from '../utils/media-upload';

/**
 * Version history for a video's edit: the pictures of every beat (each composed beat's shots
 * and shot record, or a plain beat's visual) and the caption edits, saved under a name and
 * restorable later. Shot clips go into a shared pool by content, so a version only costs the
 * clips that changed since the last one. Restoring first saves the current state, so a restore
 * can itself be undone. The narration (voice) is not part of a version.
 */

const versionsDir = (videoId: string) => path.join(rendersDir(videoId), 'vibedit-versions');
const poolDir = (videoId: string) => path.join(versionsDir(videoId), 'pool');

interface VersionBeat {
  index: number;
  asset: Record<string, unknown> | null;
  /** Composed beats: the shot record and each shot's clip in the pool. */
  sidecar?: { beatIndex: number; leadInSec?: number; tailSec?: number; shots: Array<Record<string, unknown>> };
  clips?: string[];
  trackPath?: string;
}

interface Version {
  id: string;
  label: string;
  createdAt: string;
  beats: VersionBeat[];
  captionEdits: Record<string, unknown> | null;
}

export interface VersionInfo {
  id: string;
  label: string;
  createdAt: string;
  beats: number;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Puts a clip in the pool (once per content) and returns its key. */
async function pool(videoId: string, file: string): Promise<string> {
  const key = `${await hashFile(file)}${path.extname(file) || '.mp4'}`;
  const dest = path.join(poolDir(videoId), key);
  if (!(await fs.stat(dest).then(() => true).catch(() => false))) {
    await fs.mkdir(poolDir(videoId), { recursive: true });
    await fs.copyFile(file, `${dest}.tmp`);
    await fs.rename(`${dest}.tmp`, dest);
  }
  return key;
}

const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.join(/* turbopackIgnore: true */ process.cwd(), p));

/** Saves the video's pictures and caption edits as a version. */
export async function saveVersion(supabase: SupabaseClient, videoId: string, label: string): Promise<VersionInfo> {
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  if (!video) throw new Error('Video not found');
  const { data: assets } = await supabase.from('video_assets').select('*').eq('video_id', videoId);
  const beatCount = Array.isArray(video.script_json?.beats) ? video.script_json.beats.length : 0;
  const beats: VersionBeat[] = [];
  for (let index = 0; index < beatCount; index++) {
    const asset = (assets ?? []).find((a: { beat_index: number }) => a.beat_index === index) ?? null;
    const beat: VersionBeat = { index, asset };
    if (asset?.visual_type === 'composite' && asset.source_url) {
      const trackPath = resolvePath(asset.source_url);
      const sidecar = JSON.parse(await fs.readFile(sidecarPath(trackPath), 'utf-8').catch(() => 'null'));
      if (sidecar?.shots?.length) {
        const clips: string[] = [];
        for (let n = 0; n < sidecar.shots.length; n++) clips.push(await pool(videoId, shotClipPath(trackPath, index, n)));
        Object.assign(beat, { sidecar, clips, trackPath });
      }
    }
    beats.push(beat);
  }
  const version: Version = {
    id: `${Date.now()}`,
    label: label.trim().slice(0, 120) || 'Saved version',
    createdAt: new Date().toISOString(),
    beats,
    captionEdits: (video.script_json?.caption_edits as Record<string, unknown> | undefined) ?? null,
  };
  const dir = path.join(versionsDir(videoId), version.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'version.json'), JSON.stringify(version, null, 2), 'utf-8');
  return { id: version.id, label: version.label, createdAt: version.createdAt, beats: beats.length };
}

async function readVersion(videoId: string, versionId: string): Promise<Version> {
  if (!/^\d+$/.test(versionId)) throw new Error('Invalid version');
  try {
    return JSON.parse(await fs.readFile(path.join(versionsDir(videoId), versionId, 'version.json'), 'utf-8')) as Version;
  } catch {
    throw new Error('That version no longer exists');
  }
}

export async function listVersions(videoId: string): Promise<VersionInfo[]> {
  const ids = (await fs.readdir(versionsDir(videoId)).catch(() => [] as string[])).filter((d) => /^\d+$/.test(d));
  const out: VersionInfo[] = [];
  for (const id of ids) {
    const v = await readVersion(videoId, id).catch(() => null);
    if (v) out.push({ id: v.id, label: v.label, createdAt: v.createdAt, beats: v.beats.length });
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

const shotSummary = (shots: Array<Record<string, unknown>> | undefined) =>
  (shots ?? []).map((s) => `${s.renderedType}${(s.plan as { visual_query?: string } | undefined)?.visual_query ? `: ${(s.plan as { visual_query: string }).visual_query}` : ''}`);

export interface BeatDifference {
  beat: number;
  then: string[];
  now: string[];
}

/** Which beats look different now than in the version, shot by shot. */
export async function compareVersion(supabase: SupabaseClient, videoId: string, versionId: string): Promise<BeatDifference[]> {
  const version = await readVersion(videoId, versionId);
  // The current state, summarised the same way (pool keys tell whether a clip changed)
  const { data: assets } = await supabase.from('video_assets').select('*').eq('video_id', videoId);
  const out: BeatDifference[] = [];
  for (const old of version.beats) {
    const asset = (assets ?? []).find((a: { beat_index: number }) => a.beat_index === old.index) ?? null;
    let nowShots: Array<Record<string, unknown>> | undefined;
    let nowClips: string[] | undefined;
    if (asset?.visual_type === 'composite' && asset.source_url) {
      const trackPath = resolvePath(asset.source_url);
      const sidecar = JSON.parse(await fs.readFile(sidecarPath(trackPath), 'utf-8').catch(() => 'null'));
      nowShots = sidecar?.shots;
      nowClips = [];
      for (let n = 0; n < (nowShots?.length ?? 0); n++) {
        const clip = shotClipPath(trackPath, old.index, n);
        nowClips.push(await hashFile(clip).then((h) => `${h}${path.extname(clip)}`).catch(() => 'missing'));
      }
    }
    const sameShots = old.clips && nowClips ? old.clips.length === nowClips.length && old.clips.every((c, i) => c === nowClips![i]) : !old.clips && !nowClips;
    const sameAsset = old.clips || nowClips ? true : (old.asset?.source_url ?? null) === (asset?.source_url ?? null);
    if (!sameShots || !sameAsset) {
      out.push({
        beat: old.index,
        then: old.sidecar ? shotSummary(old.sidecar.shots) : [String(old.asset?.visual_type ?? 'no visual')],
        now: nowShots ? shotSummary(nowShots) : [String(asset?.visual_type ?? 'no visual')],
      });
    }
  }
  return out;
}

/**
 * Restores a version: every beat's pictures and the caption edits. The current state is saved
 * first (as "Before restoring …"), so this can be undone by restoring that.
 */
export async function restoreVersion(supabase: SupabaseClient, videoId: string, versionId: string): Promise<{ restoredBeats: number[]; backup: VersionInfo }> {
  const version = await readVersion(videoId, versionId);
  const backup = await saveVersion(supabase, videoId, `Before restoring "${version.label}"`);
  const restored: number[] = [];
  for (const beat of version.beats) {
    if (beat.sidecar && beat.clips && beat.trackPath) {
      const clips = beat.clips.map((_, n) => shotClipPath(beat.trackPath!, beat.index, n));
      await fs.mkdir(path.dirname(clips[0]), { recursive: true });
      for (const [n, key] of beat.clips.entries()) await fs.copyFile(path.join(poolDir(videoId), key), clips[n]);
      await concatClips(clips, beat.trackPath);
      await fs.writeFile(sidecarPath(beat.trackPath), JSON.stringify(beat.sidecar, null, 2), 'utf-8');
    }
    if (beat.asset) {
      const { id: _id, ...row } = beat.asset as { id?: unknown } & Record<string, unknown>;
      void _id;
      const { data: existing } = await supabase.from('video_assets').select('id').eq('video_id', videoId).eq('beat_index', beat.index).maybeSingle();
      if (existing) await supabase.from('video_assets').update(row).eq('video_id', videoId).eq('beat_index', beat.index);
      else await supabase.from('video_assets').insert(row);
    }
    await invalidateBeatAssemblyCache(supabase, videoId, beat.index);
    restored.push(beat.index);
  }
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  if (video?.script_json) {
    await supabase
      .from('videos')
      .update({ script_json: { ...video.script_json, caption_edits: version.captionEdits ?? {} } })
      .eq('id', videoId);
  }
  return { restoredBeats: restored, backup };
}

/** Deletes a version (pool clips no other version uses are removed too). */
export async function deleteVersion(videoId: string, versionId: string): Promise<void> {
  await readVersion(videoId, versionId);
  await fs.rm(path.join(versionsDir(videoId), versionId), { recursive: true, force: true });
  const used = new Set<string>();
  for (const v of await listVersions(videoId)) for (const b of (await readVersion(videoId, v.id)).beats) for (const c of b.clips ?? []) used.add(c);
  for (const key of await fs.readdir(poolDir(videoId)).catch(() => [] as string[])) {
    if (!used.has(key)) await fs.rm(path.join(poolDir(videoId), key), { force: true });
  }
}
