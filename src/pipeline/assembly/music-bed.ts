import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import type { MusicSegment } from './music-plan';

const execFileAsync = promisify(execFile);

/** Mood changes crossfade over this long, centred on the section change. */
export const MUSIC_CROSSFADE_SEC = 3;
/** How much the music lifts into a section change (the build), as a gain above 1. */
const BUILD_GAIN = 0.3;
const BUILD_RISE_SEC = 2.5;
const BUILD_FALL_SEC = 1.5;

/**
 * Segment lengths so that, after the crossfades, every mood change is centred on its section
 * change and the bed is exactly as long as the programme.
 */
export function segmentDurations(segments: Array<{ startMs: number; endMs: number }>, crossfadeSec = MUSIC_CROSSFADE_SEC): number[] {
  const n = segments.length;
  return segments.map((s, i) => {
    const len = (s.endMs - s.startMs) / 1000;
    const extra = n === 1 ? 0 : i === 0 || i === n - 1 ? crossfadeSec / 2 : crossfadeSec;
    return Math.round((len + extra) * 1000) / 1000;
  });
}

/** The build: a gentle lift into each section change, peaking in the silent gap, then settling. */
export function buildExpression(boundariesSec: number[]): string {
  if (boundariesSec.length === 0) return '1';
  const ramps = boundariesSec.map((b) => {
    const up = `max(0,min(1,(t-${(b - BUILD_RISE_SEC - 0.5).toFixed(3)})/${BUILD_RISE_SEC}))`;
    const down = `max(0,min(1,(${(b + 0.5 + BUILD_FALL_SEC).toFixed(3)}-t)/${BUILD_FALL_SEC}))`;
    return `min(${up},${down})`;
  });
  return `1+${BUILD_GAIN}*(${ramps.join('+')})`;
}

/**
 * Renders the music for the whole programme: each segment's track from its start (looped if the
 * section outlasts it), crossfaded into the next at the section change, with builds into each
 * change. The result is mixed under the voice by applyBackgroundMusic (which ducks it).
 */
export async function buildMusicBed(
  segments: MusicSegment[],
  outputPath: string,
  /** Where each segment's track starts (seconds in), so cuts land on its beat (music-beats.ts). */
  offsetsSec: number[] = [],
): Promise<string> {
  if (segments.length === 0) throw new Error('No music segments');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const durations = segmentDurations(segments);
  const inputs = segments.flatMap((s) => ['-stream_loop', '-1', '-i', s.track.path]);
  const graph: string[] = segments.map(
    (_, i) => {
      const from = Math.max(0, offsetsSec[i] ?? 0);
      return `[${i}:a]atrim=${from.toFixed(3)}:${(from + durations[i]).toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[m${i}]`;
    },
  );
  let last = '[m0]';
  for (let i = 1; i < segments.length; i++) {
    const out = `[x${i}]`;
    graph.push(`${last}[m${i}]acrossfade=d=${MUSIC_CROSSFADE_SEC}:c1=qsin:c2=qsin${out}`);
    last = out;
  }
  const boundaries = segments.slice(1).map((s) => s.startMs / 1000);
  graph.push(`${last}volume='${buildExpression(boundaries)}':eval=frame[bed]`);

  const scriptPath = `${outputPath}.music-graph.txt`;
  await fs.writeFile(scriptPath, graph.join(';\n'), 'utf-8');
  try {
    await execFileAsync(
      getFfmpegPath(),
      ['-y', ...inputs, '-/filter_complex', scriptPath, '-map', '[bed]', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', outputPath],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    await fs.unlink(scriptPath).catch(() => {});
  }
  return outputPath;
}
