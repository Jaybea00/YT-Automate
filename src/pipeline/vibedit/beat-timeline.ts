import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getFfmpegPath } from '../utils/ffmpeg';
import { invalidateBeatAssemblyCache } from '../utils/media-upload';
import { loadWordTimings } from '../tts/word-timings';
import { voicePathsForVideo } from '../tts/voice-paths';
import { concatClips, retimeClip } from '../visuals/clips';
import { FPS } from '../visuals/motion/frame-renderer';
import type { ComposedShot } from '../visuals/shot-composer';
import { loadComposedBeat, shotClipPath, sidecarPath, type ComposedBeatRecord } from '../visuals/shot-editor';
import { editorContext } from '../visuals/shot-editor-actions';
import { candidateFromAlternative, renderCandidateShot } from '../visuals/shot-renderers';
import { kindOf } from '@/lib/script/visual-rhythm';

const execFileAsync = promisify(execFile);

/**
 * Vibedit's beat timeline: a composed beat's shots laid over its narration's waveform, to
 * reorder the shots and move the cuts between them. Reordering keeps every shot's length (only
 * the join changes); moving a cut trims one shot and lengthens its neighbour, keeping each
 * shot's picture: footage is cut again from its source, anything else holds its last frame.
 */

/** A shot can't be squeezed below this many frames (a third of a second). */
export const MIN_SHOT_FRAMES = 10;
/** Waveform resolution: peaks per second. */
const PEAKS_PER_SEC = 50;

export interface TimelineView {
  beat: number;
  fps: number;
  totalSec: number;
  /** Where the narration starts in the beat (seconds). */
  voiceStartSec: number;
  shots: Array<{ index: number; type: string; kind: string; label: string; startSec: number; durationSec: number; frames: number }>;
  /** Narration loudness, PEAKS_PER_SEC per second from the voice's start, 0-1. */
  peaks: number[];
  peaksPerSec: number;
  /** The narrator's words, in seconds from the beat's start. */
  words: Array<{ word: string; start: number; end: number }>;
}

async function voicePeaks(audioPath: string): Promise<number[]> {
  const { stdout } = await execFileAsync(
    getFfmpegPath(),
    ['-v', 'error', '-i', audioPath, '-ac', '1', '-ar', String(PEAKS_PER_SEC * 20), '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  const peaks: number[] = [];
  for (let i = 0; i < samples.length; i += 20) {
    let max = 0;
    for (let j = i; j < Math.min(i + 20, samples.length); j++) max = Math.max(max, Math.abs(samples[j]));
    peaks.push(Math.round((max / 32768) * 1000) / 1000);
  }
  return peaks;
}

const label = (s: ComposedShot) =>
  (s.plan?.title_card?.text || s.plan?.quote?.text || s.plan?.stat?.label || s.plan?.visual_query || s.renderedType).slice(0, 60);

/** The beat as the timeline shows it. */
export async function beatTimelineView(supabase: SupabaseClient, videoId: string, beatIndex: number): Promise<TimelineView> {
  const beat = await loadComposedBeat(supabase, videoId, beatIndex);
  if (!beat) throw new Error('This beat is one visual, not shots: there is nothing to rearrange');
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  const beatCount = Array.isArray(video?.script_json?.beats) ? video.script_json.beats.length : beatIndex + 1;
  const audio = (await voicePathsForVideo(supabase, videoId, video?.script_json, beatCount)).get(beatIndex) ?? null;
  const timings = audio ? await loadWordTimings(audio) : null;
  const shots = beat.shots.map((s, index) => ({
    index,
    type: s.renderedType,
    kind: kindOf(s.renderedType),
    label: label(s),
    startSec: s.startSec,
    durationSec: s.durationSec,
    frames: s.frames,
  }));
  const last = shots[shots.length - 1];
  return {
    beat: beatIndex,
    fps: FPS,
    totalSec: last ? last.startSec + last.durationSec : 0,
    voiceStartSec: beat.leadInSec,
    shots,
    peaks: audio ? await voicePeaks(audio).catch(() => []) : [],
    peaksPerSec: PEAKS_PER_SEC,
    words: (timings?.words ?? []).map((w) => ({ word: w.word, start: beat.leadInSec + w.start, end: beat.leadInSec + w.end })),
  };
}

/** Writes the beat back: its clips joined in order, its shot record, and a fresh assembly. */
async function writeBeat(supabase: SupabaseClient, videoId: string, beat: ComposedBeatRecord, shots: ComposedShot[]): Promise<void> {
  let start = 0;
  const timed = shots.map((s, i) => {
    const out = { ...s, startSec: start, durationSec: s.frames / FPS, clipPath: shotClipPath(beat.trackPath, beat.beatIndex, i) };
    start += s.frames / FPS;
    return out;
  });
  await concatClips(timed.map((s) => s.clipPath), beat.trackPath);
  await fs.writeFile(
    sidecarPath(beat.trackPath),
    JSON.stringify({ beatIndex: beat.beatIndex, leadInSec: beat.leadInSec, tailSec: beat.tailSec, shots: timed }, null, 2),
    'utf-8',
  );
  await invalidateBeatAssemblyCache(supabase, videoId, beat.beatIndex);
}

/** Puts the beat's shots in a new order (`order` lists the current shot numbers, in the new order). */
export async function reorderShots(supabase: SupabaseClient, videoId: string, beatIndex: number, order: number[]): Promise<TimelineView> {
  const beat = await loadComposedBeat(supabase, videoId, beatIndex);
  if (!beat) throw new Error('This beat has no shots to reorder');
  const n = beat.shots.length;
  if (order.length !== n || new Set(order).size !== n || order.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) {
    throw new Error('The new order must list every shot once');
  }
  if (order.every((i, pos) => i === pos)) return beatTimelineView(supabase, videoId, beatIndex);

  // Clips are named by position: move them aside, then back in the new order
  const aside = order.map((_, pos) => `${shotClipPath(beat.trackPath, beatIndex, pos)}.reorder`);
  for (let pos = 0; pos < n; pos++) await fs.rename(shotClipPath(beat.trackPath, beatIndex, pos), aside[pos]);
  for (const [pos, from] of order.entries()) await fs.rename(aside[from], shotClipPath(beat.trackPath, beatIndex, pos));
  await writeBeat(supabase, videoId, beat, order.map((i) => beat.shots[i]));
  return beatTimelineView(supabase, videoId, beatIndex);
}

/**
 * Moves the cut after shot `cut` by `deltaFrames` (positive: later). The shot before it gets
 * longer or shorter, the one after it the opposite; the beat's length and every other cut stay.
 */
export async function moveCut(
  supabase: SupabaseClient,
  videoId: string,
  beatIndex: number,
  cut: number,
  deltaFrames: number,
): Promise<TimelineView> {
  const beat = await loadComposedBeat(supabase, videoId, beatIndex);
  if (!beat) throw new Error('This beat has no shots');
  const a = beat.shots[cut];
  const b = beat.shots[cut + 1];
  if (!a || !b) throw new Error('There is no cut there');
  const delta = Math.round(deltaFrames);
  if (delta === 0) return beatTimelineView(supabase, videoId, beatIndex);
  const framesA = a.frames + delta;
  const framesB = b.frames - delta;
  if (framesA < MIN_SHOT_FRAMES || framesB < MIN_SHOT_FRAMES) throw new Error('That would leave a shot too short to see');

  const resized = [
    { index: cut, shot: a, frames: framesA },
    { index: cut + 1, shot: b, frames: framesB },
  ];
  const temps: string[] = [];
  try {
    for (const r of resized) {
      const clip = shotClipPath(beat.trackPath, beatIndex, r.index);
      const temp = clip.replace(/\.mp4$/, '.retimed.mp4');
      temps.push(temp);
      const longer = r.frames > r.shot.frames;
      // Footage that has to run longer is cut again from its source; anything else keeps its picture
      if (longer && r.shot.chosen && kindOf(r.shot.renderedType) === 'footage') {
        const { ctx, close } = await editorContext(supabase, videoId, beat, Boolean(r.shot.plan?.caption));
        try {
          if (r.shot.sourceUrl) ctx.usedSources.delete(r.shot.sourceUrl);
          const rendered = await renderCandidateShot(r.shot.plan, { shot: r.shot.plan, startSec: 0, frames: r.frames }, temp, ctx, candidateFromAlternative(r.shot.chosen), {
            note: r.shot.note,
          });
          if (rendered.clipPath !== temp) await fs.rename(rendered.clipPath, temp);
        } finally {
          await close();
        }
      } else {
        await retimeClip(clip, r.frames, temp);
      }
    }
    for (const [i, r] of resized.entries()) await fs.rename(temps[i], shotClipPath(beat.trackPath, beatIndex, r.index));
  } catch (err) {
    for (const t of temps) await fs.rm(t, { force: true });
    throw err;
  }
  const shots = beat.shots.map((s, i) => (i === cut ? { ...s, frames: framesA } : i === cut + 1 ? { ...s, frames: framesB } : s));
  await writeBeat(supabase, videoId, beat, shots);
  return beatTimelineView(supabase, videoId, beatIndex);
}

