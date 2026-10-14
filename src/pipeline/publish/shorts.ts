import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { writeAssCaptionsFile } from '../assembly/captions';
import type { LLMProvider, ProviderCallContext } from '../providers/types';
import { getFfmpegPath } from '../utils/ffmpeg';
import type { VideoTimeline } from '../utils/timeline';

const execFileAsync = promisify(execFile);

/**
 * Shorts cut from the finished video: the strongest self-contained moments (whole beats, 20-59 s),
 * reframed for vertical. The full 16:9 picture sits in the middle (graphics stay complete) over a
 * blurred fill, with big word-by-word captions below, a hook banner on top, and a pointer to the
 * full video at the end.
 */

export const SHORT_WIDTH = 1080;
export const SHORT_HEIGHT = 1920;
const MIN_SHORT_SEC = 20;
/** YouTube counts up to 60 s as a Short; a second of margin keeps it safely under. */
const MAX_SHORT_SEC = 59;
const MAX_SHORTS = 3;
const END_CARD_SEC = 2.5;
const EDGE_FADE_SEC = 0.3;

export interface ShortPlan {
  startBeat: number;
  endBeat: number;
  title: string;
  hook: string;
}

export interface ShortClip extends ShortPlan {
  path: string;
  startSec: number;
  endSec: number;
}

/** A run of whole beats: where it starts and ends in the video (from the timeline). */
export function spanOf(timeline: VideoTimeline, startBeat: number, endBeat: number): { startSec: number; endSec: number } | null {
  const first = timeline.beats.find((b) => b.index === startBeat);
  const last = timeline.beats.find((b) => b.index === endBeat);
  if (!first || !last || endBeat < startBeat) return null;
  // Open on the voice (the lead-in would be a beat of silence), close at the end of the scene
  return { startSec: first.voiceStartMs / 1000, endSec: (last.sceneStartMs + last.sceneMs) / 1000 };
}

/**
 * Keeps plans usable: real beat ranges, 20-59 s (a too-long range is shortened by whole beats),
 * no overlaps, at most three.
 */
export function normalizeShortPlans(plans: ShortPlan[], timeline: VideoTimeline): ShortPlan[] {
  const out: ShortPlan[] = [];
  for (const p of plans) {
    let end = p.endBeat;
    let span = spanOf(timeline, p.startBeat, end);
    while (span && span.endSec - span.startSec > MAX_SHORT_SEC && end > p.startBeat) {
      end--;
      span = spanOf(timeline, p.startBeat, end);
    }
    if (!span || span.endSec - span.startSec < MIN_SHORT_SEC || span.endSec - span.startSec > MAX_SHORT_SEC) continue;
    if (out.some((o) => p.startBeat <= o.endBeat && end >= o.startBeat)) continue;
    const title = p.title.replace(/\s+/g, ' ').trim().slice(0, 90);
    const hook = p.hook.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().toUpperCase().split(' ').slice(0, 6).join(' ');
    out.push({ startBeat: p.startBeat, endBeat: end, title: title || hook, hook });
  }
  return out.slice(0, MAX_SHORTS);
}

const ShortsSchema = z.object({
  shorts: z.array(z.object({ start_beat: z.number(), end_beat: z.number(), title: z.string(), hook: z.string() })),
});

/** The LLM picks the moments that work on their own as Shorts. */
export async function planShorts(options: {
  beats: Array<{ index: number; text: string }>;
  timeline: VideoTimeline;
  topic: string;
  llm: LLMProvider;
  ctx: ProviderCallContext;
}): Promise<ShortPlan[]> {
  const { beats, timeline, topic, llm, ctx } = options;
  const listing = beats
    .map((b) => {
      const t = timeline.beats.find((x) => x.index === b.index);
      return `[${b.index}] (${t ? (t.sceneMs / 1000).toFixed(1) : '?'}s) ${b.text}`;
    })
    .join('\n');
  const { data } = await llm.generateJson(
    {
      system: 'You cut YouTube Shorts from documentary videos. A good Short stands alone, opens on a hook in its first line, and pays off before it ends.',
      prompt: `Video topic: "${topic}"

Beats (index, length, narration):
${listing}

Choose up to ${MAX_SHORTS} Shorts. Each is a run of consecutive beats lasting ${MIN_SHORT_SEC}-${MAX_SHORT_SEC} seconds in total, starting on a beat that hooks a viewer with no context, and ending on a satisfying line. Don't overlap them.
For each: start_beat, end_beat (inclusive), a title (under 70 characters, intriguing and true), and a hook banner of 2-6 words shown on screen.`,
      schema: ShortsSchema,
    },
    ctx,
  );
  return normalizeShortPlans(
    data.shorts.map((s) => ({ startBeat: s.start_beat, endBeat: s.end_beat, title: s.title, hook: s.hook })),
    timeline,
  );
}

/** Without the LLM: the opening of each section, grown beat by beat to Short length. */
export function fallbackShortPlans(timeline: VideoTimeline, sectionStarts: number[], title: string): ShortPlan[] {
  const plans: ShortPlan[] = [];
  const starts = sectionStarts.length ? [...sectionStarts].sort((a, b) => a - b) : [timeline.beats[0]?.index ?? 0];
  for (const [i, start] of starts.entries()) {
    // Each Short stays inside its own section
    const nextSection = starts[i + 1] ?? Number.POSITIVE_INFINITY;
    let end = start;
    let span = spanOf(timeline, start, end);
    while (span && span.endSec - span.startSec < 40 && end + 1 < nextSection && timeline.beats.some((b) => b.index === end + 1)) {
      const next = spanOf(timeline, start, end + 1);
      if (!next || next.endSec - next.startSec > MAX_SHORT_SEC) break;
      end++;
      span = next;
    }
    plans.push({ startBeat: start, endBeat: end, title, hook: title });
  }
  return normalizeShortPlans(plans, timeline);
}

/** The vertical frame: the picture centred over a blurred, zoomed copy of itself, faded at the edges. */
export function verticalFilter(durationSec: number, assFile: string): string {
  const fadeOut = Math.max(0, durationSec - EDGE_FADE_SEC).toFixed(3);
  return (
    `[0:v]split=2[bg][fg];` +
    `[bg]scale=${SHORT_WIDTH}:${SHORT_HEIGHT}:force_original_aspect_ratio=increase,crop=${SHORT_WIDTH}:${SHORT_HEIGHT},gblur=sigma=30,eq=brightness=-0.12[bgb];` +
    `[fg]scale=${SHORT_WIDTH}:-2[fgs];` +
    `[bgb][fgs]overlay=0:(H-h)/2-140,ass=${assFile},` +
    `fade=t=in:st=0:d=${EDGE_FADE_SEC},fade=t=out:st=${fadeOut}:d=${EDGE_FADE_SEC},scale=out_range=tv,format=yuv420p[v]`
  );
}

/** Renders one Short from the finished video. */
export async function renderShort(options: {
  videoPath: string;
  plan: ShortPlan;
  timeline: VideoTimeline;
  beats: Array<{ index: number; text: string }>;
  words: Record<number, Array<{ word: string; start: number; end: number }>>;
  highlightHex: string;
  outPath: string;
}): Promise<ShortClip> {
  const { videoPath, plan, timeline, beats, words, highlightHex, outPath } = options;
  const span = spanOf(timeline, plan.startBeat, plan.endBeat);
  if (!span) throw new Error(`Beats ${plan.startBeat}-${plan.endBeat} are not in the video`);
  const duration = span.endSec - span.startSec;
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  // Captions for the Short's beats, timed from the Short's own start
  const inShort = timeline.beats.filter((b) => b.index >= plan.startBeat && b.index <= plan.endBeat);
  const assPath = outPath.replace(/\.mp4$/, '.ass');
  await writeAssCaptionsFile(
    {
      beats: inShort.map((b) => ({ index: b.index, text: beats.find((x) => x.index === b.index)?.text ?? '' })),
      units: inShort.map((b) => ({ unit_index: b.index, duration_ms: b.voiceMs })),
      beatStartMs: inShort.map((b) => b.voiceStartMs - span.startSec * 1000),
      words,
      preset: 'social_pop',
      highlightHex,
      resolution: { width: SHORT_WIDTH, height: SHORT_HEIGHT },
      fontSize: 84,
      marginV: 420,
      banners: [
        { text: plan.hook, startMs: 0, endMs: Math.round((duration - END_CARD_SEC) * 1000), position: 'top' },
        { text: 'FULL STORY ON THE CHANNEL', startMs: Math.round((duration - END_CARD_SEC) * 1000), endMs: Math.round(duration * 1000), position: 'top' },
      ],
    },
    assPath,
  );

  try {
    await execFileAsync(
      getFfmpegPath(),
      [
        '-y', '-ss', span.startSec.toFixed(3), '-t', duration.toFixed(3), '-i', path.resolve(videoPath),
        '-filter_complex', verticalFilter(duration, path.basename(assPath)),
        '-map', '[v]', '-map', '0:a:0',
        '-af', `afade=t=in:st=0:d=${EDGE_FADE_SEC},afade=t=out:st=${Math.max(0, duration - EDGE_FADE_SEC).toFixed(3)}:d=${EDGE_FADE_SEC}`,
        '-c:v', 'libx264', '-preset', 'faster', '-crf', '19', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', '30',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', path.resolve(outPath),
      ],
      { cwd: path.dirname(path.resolve(assPath)), maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    await fs.unlink(assPath).catch(() => {});
  }
  return { ...plan, path: outPath, startSec: span.startSec, endSec: span.endSec };
}
