import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import type { VideoTimeline } from '../utils/timeline';
import { readSidecar } from '../visuals/shot-editor';

const execFileAsync = promisify(execFile);

/**
 * Smart reframing for Shorts. Footage fills the vertical frame: a full-height 9:16 crop that
 * follows the subject (the nearest thing in the picture, from the same depth model as the 2.5D
 * parallax), panning smoothly and holding still when the subject barely moves. Charts, maps, text
 * cards and screen recordings keep the whole 16:9 picture over the blurred fill, so nothing on
 * them is cut off. A shot is footage or not from the beat's shot record, not guessed from pixels.
 */

export interface ReframeSegment {
  /** Seconds from the start of the Short. */
  startSec: number;
  endSec: number;
  /** 'crop' follows the subject full-frame; 'fit' shows the whole picture. */
  mode: 'crop' | 'fit';
}

/** Shot types that are camera pictures and can lose their sides. */
const CROPPABLE = new Set(['stock', 'archive']);
/** A crop shorter than this stays whole: switching layouts for a moment is jarring. */
const MIN_CROP_SEC = 1.2;
/** How often the subject is looked for, and how fast the crop may pan (share of width per second). */
const SAMPLE_EVERY_SEC = 1;
const MAX_PAN_PER_SEC = 0.18;
/** Moves smaller than this (share of width) are ignored, so the crop doesn't drift. */
const DEAD_ZONE = 0.05;
const FPS = 30;

type SidecarReader = (trackPath: string) => Promise<{ shots: Array<{ renderedType: string; startSec: number; durationSec: number }> } | null>;

/**
 * The Short's stretches, crop or fit, from each beat's recorded shots. A beat with no shot record
 * (one uploaded visual, say) is shown whole, as before.
 */
export async function reframeSegments(
  timeline: VideoTimeline,
  span: { startSec: number; endSec: number },
  readShots: SidecarReader = readSidecar,
): Promise<ReframeSegment[]> {
  const raw: ReframeSegment[] = [];
  const duration = span.endSec - span.startSec;
  for (const beat of timeline.beats) {
    const beatStart = beat.sceneStartMs / 1000;
    const beatEnd = beatStart + beat.sceneMs / 1000;
    if (beatEnd <= span.startSec || beatStart >= span.endSec) continue;
    const sidecar = beat.trackPath ? await readShots(beat.trackPath).catch(() => null) : null;
    const shots = sidecar?.shots?.length
      ? sidecar.shots.map((s) => ({ start: beatStart + s.startSec, end: beatStart + s.startSec + s.durationSec, type: s.renderedType }))
      : [{ start: beatStart, end: beatEnd, type: 'unknown' }];
    for (const s of shots) {
      const startSec = Math.max(0, s.start - span.startSec);
      const endSec = Math.min(duration, s.end - span.startSec);
      if (endSec - startSec > 0.01) raw.push({ startSec, endSec, mode: CROPPABLE.has(s.type) ? 'crop' : 'fit' });
    }
  }
  // Short crops stay whole, then neighbours of the same mode join up
  const merged: ReframeSegment[] = [];
  for (const seg of raw.map((s) => (s.mode === 'crop' && s.endSec - s.startSec < MIN_CROP_SEC ? { ...s, mode: 'fit' as const } : s))) {
    const last = merged[merged.length - 1];
    if (last && last.mode === seg.mode && seg.startSec - last.endSec < 0.05) last.endSec = Math.max(last.endSec, seg.endSec);
    else merged.push({ ...seg });
  }
  return merged;
}

/**
 * Where the subject is across a frame (0 left, 1 right) from its depth map: the centre of the
 * nearest quarter of the picture. Null when nothing stands out (a flat or uniform picture).
 */
export function subjectCentre(gray: Uint8Array, width: number, height: number): number | null {
  const sorted = Array.from(gray).sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  if (pct(0.9) - pct(0.1) < 24) return null;
  const near = pct(0.75);
  let sum = 0;
  let weight = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = gray[y * width + x];
      if (v < near) continue;
      const w = v - near + 1;
      sum += w * (x + 0.5);
      weight += w;
    }
  }
  return weight ? sum / weight / width : null;
}

/**
 * A smooth path through the sampled centres: gaps held from the last known place (centre at
 * first), small moves ignored, and pans no faster than MAX_PAN_PER_SEC.
 */
export function smoothPath(samples: Array<{ t: number; x: number | null }>): Array<{ t: number; x: number }> {
  const out: Array<{ t: number; x: number }> = [];
  let held = samples.find((s) => s.x !== null)?.x ?? 0.5;
  // Light smoothing: the median of each sample and its neighbours
  const filled = samples.map((s) => (s.x === null ? null : s.x));
  for (let i = 0; i < samples.length; i++) {
    const near = [filled[i - 1], filled[i], filled[i + 1]].filter((v): v is number => v !== null && v !== undefined).sort((a, b) => a - b);
    // A frame with no clear subject holds where the crop is
    const target = filled[i] === null || !near.length ? held : near[Math.floor(near.length / 2)];
    const prev = out[out.length - 1];
    let x = Math.abs(target - held) < DEAD_ZONE ? held : target;
    if (prev) {
      const maxStep = MAX_PAN_PER_SEC * Math.max(0.001, samples[i].t - prev.t);
      x = prev.x + Math.max(-maxStep, Math.min(maxStep, x - prev.x));
    }
    held = x;
    out.push({ t: samples[i].t, x });
  }
  return out;
}

/** The crop's left edge (pixels) at each frame of a segment, eased between the path's points. */
export function cropPositions(path: Array<{ t: number; x: number }>, seg: ReframeSegment, sourceWidth: number, cropWidth: number): Array<{ t: number; px: number }> {
  const out: Array<{ t: number; px: number }> = [];
  const maxLeft = sourceWidth - cropWidth;
  for (let f = Math.round(seg.startSec * FPS); f < Math.round(seg.endSec * FPS); f++) {
    const t = f / FPS;
    let x = path[0]?.x ?? 0.5;
    for (let i = 0; i < path.length - 1; i++) {
      if (t >= path[i].t && t <= path[i + 1].t) {
        const k = (t - path[i].t) / Math.max(0.001, path[i + 1].t - path[i].t);
        const eased = k * k * (3 - 2 * k);
        x = path[i].x + (path[i + 1].x - path[i].x) * eased;
        break;
      }
      if (t > path[i + 1].t) x = path[i + 1].x;
    }
    out.push({ t, px: Math.round(Math.max(0, Math.min(maxLeft, x * sourceWidth - cropWidth / 2))) });
  }
  return out;
}

async function grayPixels(file: string, width: number, height: number): Promise<Uint8Array> {
  const { stdout } = await execFileAsync(
    getFfmpegPath(),
    ['-v', 'error', '-i', file, '-vf', `scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
  );
  return new Uint8Array(stdout);
}

export type SubjectFinder = (framePath: string) => Promise<number | null>;

/** The depth model's view of a frame: where the nearest subject is. */
export const depthSubject: SubjectFinder = async (framePath) => {
  const { depthMap } = await import('../visuals/parallax');
  return subjectCentre(await grayPixels(await depthMap(framePath), 64, 36), 64, 36);
};

/**
 * The sendcmd lines that move the crop for every crop segment, following the subject. If the
 * depth model can't run, the crop holds the centre.
 */
export async function trackCrops(options: {
  videoPath: string;
  /** Where the Short starts in the video. */
  offsetSec: number;
  segments: ReframeSegment[];
  sourceWidth: number;
  cropWidth: number;
  workDir: string;
  findSubject?: SubjectFinder;
}): Promise<string[]> {
  const { videoPath, offsetSec, segments, sourceWidth, cropWidth, workDir } = options;
  const findSubject = options.findSubject ?? depthSubject;
  const lines: string[] = [];
  let modelFailed = false;
  for (const [n, seg] of segments.entries()) {
    if (seg.mode !== 'crop') continue;
    const len = seg.endSec - seg.startSec;
    const times = Array.from({ length: Math.max(1, Math.ceil(len / SAMPLE_EVERY_SEC)) }, (_, i) =>
      Math.min(seg.endSec - 0.05, seg.startSec + Math.min(len / 2, 0.25) + i * SAMPLE_EVERY_SEC),
    );
    const samples: Array<{ t: number; x: number | null }> = [];
    for (const [i, t] of times.entries()) {
      let x: number | null = null;
      if (!modelFailed) {
        const frame = path.join(workDir, `seg${n}_${i}.png`);
        try {
          await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', (offsetSec + t).toFixed(3), '-i', path.resolve(videoPath), '-frames:v', '1', '-vf', 'scale=384:-2', frame]);
          x = await findSubject(frame);
        } catch (err) {
          modelFailed = true;
          console.warn(`[Shorts] Subject tracking unavailable, crops hold the centre: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
        }
      }
      samples.push({ t, x });
    }
    for (const { t, px } of cropPositions(smoothPath(samples), seg, sourceWidth, cropWidth)) {
      lines.push(`${t.toFixed(3)} crop@rf x ${px};`);
    }
  }
  return lines;
}

/** Writes the crop's moves for sendcmd; returns the file name (relative to the ffmpeg cwd). */
export async function writeCropCommands(lines: string[], file: string): Promise<string> {
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf-8');
  return path.basename(file);
}

/** Where the crop layout is on screen, for overlay's enable= (seconds into the Short). */
export function cropEnable(segments: ReframeSegment[]): string {
  return segments
    .filter((s) => s.mode === 'crop')
    .map((s) => `between(t,${s.startSec.toFixed(3)},${(s.endSec - 0.001).toFixed(3)})`)
    .join('+');
}
