import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '../providers/registry';
import type { LLMProvider, LlmImage } from '../providers/types';
import { getFfmpegPath } from '../utils/ffmpeg';
import { probeMediaFile, sniffMediaType } from '../utils/media-upload';
import { loadComposedBeat } from './shot-editor';

const execFileAsync = promisify(execFile);

/**
 * Smart batch matching: the creator drops a folder of clips and photos, and each is matched by
 * what it shows (not its file name) to the shot it fits best, with the best seconds of a video.
 * A long clip can fill several shots from different parts of it.
 */

export interface StagedFile {
  id: string;
  name: string;
  path: string;
  isVideo: boolean;
  durationSec: number;
}

/** A place footage can go: a footage shot of a composed beat, or a whole single-visual beat. */
export interface MatchTarget {
  beat_index: number;
  /** null for a beat without a shot list (the upload replaces the beat's visual). */
  shot_index: number | null;
  query: string;
  covers: string;
  durationSec: number;
}

export interface MatchProposal {
  fileId: string;
  fileName: string;
  beat_index: number;
  shot_index: number | null;
  startSec: number;
  score: number;
  reason: string;
}

/** Below this, a file isn't proposed for a shot. */
export const MIN_MATCH_SCORE = 6;
const FRAMES_PER_VIDEO = 8;
const SECONDS_PER_FRAME = 3;
const IMAGES_PER_CALL = 36;

const stageDir = (videoId: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(videoId)) throw new Error('Invalid video id');
  return path.join(process.cwd(), 'storage', 'uploads', videoId, 'batch');
};

/** Saves one dropped file for matching; nothing in the video changes yet. */
export async function stageFile(videoId: string, name: string, buffer: Buffer): Promise<StagedFile> {
  const sniffed = sniffMediaType(buffer);
  if (!sniffed) throw new Error(`${name}: unsupported file (use mp4, mov, webm, jpg, png or webp)`);
  const id = randomUUID();
  const dir = stageDir(videoId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.${sniffed.ext}`);
  await fs.writeFile(file, buffer);
  try {
    const info = await probeMediaFile(file);
    const staged: StagedFile = { id, name: name.slice(0, 200), path: file, isVideo: info.isVideo, durationSec: info.durationMs / 1000 };
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(staged), 'utf-8');
    return staged;
  } catch (err) {
    await fs.unlink(file).catch(() => {});
    throw new Error(`${name}: the file can't be read (${err instanceof Error ? err.message.slice(0, 120) : err})`);
  }
}

export async function loadStaged(videoId: string, id: string): Promise<StagedFile | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(stageDir(videoId), `${id}.json`), 'utf-8')) as StagedFile;
  } catch {
    return null;
  }
}

/** Times to look at in a video: spread through it, about one every few seconds. */
export function frameTimes(durationSec: number): number[] {
  if (durationSec <= 0) return [0];
  const n = Math.max(1, Math.min(FRAMES_PER_VIDEO, Math.ceil(durationSec / SECONDS_PER_FRAME)));
  return Array.from({ length: n }, (_, i) => Math.round(((durationSec * (i + 0.5)) / n) * 10) / 10);
}

async function grabFrame(file: string, atSec: number | null): Promise<LlmImage> {
  const { stdout } = await execFileAsync(
    getFfmpegPath(),
    [...(atSec !== null ? ['-ss', String(atSec)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=384:-2', '-q:v', '6', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
  );
  return { mimeType: 'image/jpeg', data: (stdout as Buffer).toString('base64') };
}

/** Footage shots and text-card stand-ins of composed beats, and single-visual beats. */
export async function matchTargets(supabase: SupabaseClient, videoId: string): Promise<MatchTarget[]> {
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  const beats: Array<{ index: number; text: string; visual_query?: string; duration_estimate_seconds?: number }> = video?.script_json?.beats ?? [];
  const targets: MatchTarget[] = [];
  for (const beat of beats) {
    const composed = await loadComposedBeat(supabase, videoId, beat.index).catch(() => null);
    if (composed) {
      composed.shots.forEach((s, i) => {
        // Graphics (charts, maps, titles) stay; footage and text-card stand-ins can take a clip
        const footage = s.renderedType === 'stock' || s.renderedType === 'archive' || s.renderedType === 'color' || s.fallback;
        if (!footage) return;
        targets.push({ beat_index: beat.index, shot_index: i, query: s.plan.visual_query, covers: s.plan.covers ?? '', durationSec: s.durationSec });
      });
    } else {
      targets.push({ beat_index: beat.index, shot_index: null, query: beat.visual_query ?? '', covers: beat.text, durationSec: beat.duration_estimate_seconds ?? 8 });
    }
  }
  return targets;
}

const MatchSchema = z.object({
  matches: z.array(
    z.object({ file: z.number(), start_sec: z.number(), target: z.number(), score: z.number(), reason: z.string() }),
  ),
});

export function buildMatchPrompt(
  files: Array<{ label: number; name: string; isVideo: boolean; durationSec: number; frames: number[] }>,
  targets: MatchTarget[],
): string {
  return `You are placing a creator's own footage into a documentary edit.

SHOTS that need footage (number, length, what it should show, narration over it):
${targets.map((t, i) => `T${i + 1} (${t.durationSec.toFixed(1)} s): ${t.query} | "${t.covers.slice(0, 160)}"`).join('\n')}

The images that follow are, in order:
${files
  .map((f) => (f.isVideo ? f.frames.map((s) => `file ${f.label} "${f.name}" (video, ${f.durationSec.toFixed(0)} s) at ${s} s`).join('\n') : `file ${f.label} "${f.name}" (photo)`))
  .join('\n')}

Match files to shots by what the footage actually shows. A long video can serve several shots from different moments. Only propose matches that clearly fit (score 0-10; 7+ means a good fit). For each match: file (number), start_sec (where in the video the shot's footage should start; 0 for a photo), target (the T number), score, reason (a few words).`;
}

/** Keeps good matches: real files and targets, one file per target (the best), no overlapping use of a video. */
export function normalizeMatches(
  raw: z.infer<typeof MatchSchema>['matches'],
  files: Array<{ label: number; staged: StagedFile }>,
  targets: MatchTarget[],
): MatchProposal[] {
  const byLabel = new Map(files.map((f) => [f.label, f.staged]));
  const usedTargets = new Set<number>();
  const usedRanges = new Map<string, Array<[number, number]>>();
  const out: MatchProposal[] = [];
  for (const m of [...raw].sort((a, b) => b.score - a.score)) {
    const staged = byLabel.get(m.file);
    const target = targets[m.target - 1];
    if (!staged || !target || m.score < MIN_MATCH_SCORE || usedTargets.has(m.target)) continue;
    const startSec = staged.isVideo ? Math.max(0, Math.min(m.start_sec, Math.max(0, staged.durationSec - target.durationSec))) : 0;
    if (staged.isVideo) {
      const range: [number, number] = [startSec, startSec + target.durationSec];
      const ranges = usedRanges.get(staged.id) ?? [];
      if (ranges.some(([a, b]) => range[0] < b && range[1] > a)) continue;
      usedRanges.set(staged.id, [...ranges, range]);
    }
    usedTargets.add(m.target);
    out.push({
      fileId: staged.id,
      fileName: staged.name,
      beat_index: target.beat_index,
      shot_index: target.shot_index,
      startSec: Math.round(startSec * 10) / 10,
      score: m.score,
      reason: m.reason.trim(),
    });
  }
  return out.sort((a, b) => a.beat_index - b.beat_index || (a.shot_index ?? 0) - (b.shot_index ?? 0));
}

/** Matches staged files to the video's shots by looking at them. */
export async function matchStagedFiles(supabase: SupabaseClient, videoId: string, staged: StagedFile[]): Promise<MatchProposal[]> {
  const targets = await matchTargets(supabase, videoId);
  if (targets.length === 0 || staged.length === 0) return [];
  const { provider, ctx } = await resolveForStage<LLMProvider>('script', supabase);
  if (!provider.supportsVision) throw new Error('Matching needs a script model that can see images (Gemini)');

  // Calls of up to IMAGES_PER_CALL images; every call sees every shot
  const proposals: MatchProposal[] = [];
  let batch: Array<{ label: number; staged: StagedFile; frames: number[]; images: LlmImage[] }> = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const { data } = await provider.generateJson(
      {
        system: 'You are a documentary editor matching footage to shots by what it shows.',
        prompt: buildMatchPrompt(
          batch.map((b) => ({ label: b.label, name: b.staged.name, isVideo: b.staged.isVideo, durationSec: b.staged.durationSec, frames: b.frames })),
          targets,
        ),
        schema: MatchSchema,
        images: batch.flatMap((b) => b.images),
        maxTokens: 3000,
      },
      ctx,
    );
    proposals.push(...normalizeMatches(data.matches, batch, targets));
    batch = [];
  };
  for (const [i, file] of staged.entries()) {
    const frames = file.isVideo ? frameTimes(file.durationSec) : [];
    const images = file.isVideo ? await Promise.all(frames.map((t) => grabFrame(file.path, t))) : [await grabFrame(file.path, null)];
    if (batch.reduce((n, b) => n + b.images.length, 0) + images.length > IMAGES_PER_CALL) await flush();
    batch.push({ label: i + 1, staged: file, frames, images });
  }
  await flush();

  // Across calls, a target still gets only its best match
  const best = new Map<string, MatchProposal>();
  for (const p of proposals) {
    const key = `${p.beat_index}:${p.shot_index}`;
    if (!best.has(key) || best.get(key)!.score < p.score) best.set(key, p);
  }
  return [...best.values()].sort((a, b) => a.beat_index - b.beat_index || (a.shot_index ?? 0) - (b.shot_index ?? 0));
}
