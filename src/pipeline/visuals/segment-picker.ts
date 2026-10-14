import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ShotPlan } from '@/lib/script/generate-script';
import type { LLMProvider, ProviderCallContext } from '../providers/types';
import { getFfmpegPath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);

/** Frames sampled across a long film to find the part that shows the shot. */
const SAMPLE_FRAMES = 6;
/** A sampled frame must score at least this to be chosen over the default start. */
const MIN_SEGMENT_SCORE = 5;

const FrameRatingSchema = z.object({
  ratings: z.array(z.object({ index: z.number(), score: z.number(), reason: z.string() })),
});

/** Times to sample: spread across the film, each leaving room for the whole shot after it. */
export function sampleTimes(sourceSec: number, shotSec: number, count = SAMPLE_FRAMES): number[] {
  const last = Math.max(0, sourceSec - shotSec - 0.3);
  return Array.from({ length: count }, (_, i) => {
    const t = sourceSec * (0.06 + (0.88 * i) / Math.max(1, count - 1));
    return Math.round(Math.min(t, last) * 1000) / 1000;
  }).filter((t, i, all) => all.indexOf(t) === i);
}

/**
 * For a long film (archive reels run minutes; the shot needs seconds), finds where the subject
 * actually appears: samples frames across it and has the LLM pick the one that best shows the
 * shot, skipping title cards, intertitles and black frames. Returns the start time, or null to
 * use the default.
 */
export async function pickVideoSegment(options: {
  sourcePath: string;
  sourceSec: number;
  shotSec: number;
  shot: ShotPlan;
  llm?: LLMProvider;
  llmCtx?: ProviderCallContext;
}): Promise<number | null> {
  const { sourcePath, sourceSec, shotSec, shot, llm, llmCtx } = options;
  if (!llm?.supportsVision || !llmCtx || sourceSec <= shotSec * 3) return null;

  const times = sampleTimes(sourceSec, shotSec);
  const dir = await fs.mkdtemp(path.join(path.dirname(sourcePath), 'frames-'));
  try {
    const images = [];
    for (const [i, t] of times.entries()) {
      const out = path.join(dir, `f${i}.jpg`);
      await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', sourcePath, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out]);
      images.push({ mimeType: 'image/jpeg', data: (await fs.readFile(out)).toString('base64') });
    }
    const { data } = await llm.generateJson(
      {
        prompt: `These ${images.length} frames (numbered 1 to ${images.length} in order) come from different points of one film.
A documentary shot needs: ${shot.visual_query}
Narration over it: "${shot.covers}"
Rate each frame 0-10 for how well the footage around it would show this shot. Score 0 for title cards, intertitles, credits, black or blank frames, and text-only frames.`,
        schema: FrameRatingSchema,
        images,
        maxTokens: 800,
      },
      llmCtx,
    );
    const best = [...data.ratings].sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < MIN_SEGMENT_SCORE || !times[best.index - 1]) return null;
    // Start a moment before the chosen frame so the shot opens on it rather than cutting past it
    return Math.max(0, Math.round((times[best.index - 1] - Math.min(0.5, shotSec * 0.2)) * 1000) / 1000);
  } catch (err) {
    console.warn(`[SegmentPicker] Using default start: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
