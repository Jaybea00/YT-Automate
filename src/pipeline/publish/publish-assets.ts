import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LLMProvider, ProviderCallContext } from '../providers/types';
import type { VideoTimeline } from '../utils/timeline';
import type { MotionTheme } from '../visuals/motion/theme';
import { candidateMoments, extractFrames, fallbackPlans, planThumbnails, renderThumbnails, type Thumbnail } from './thumbnails';

export const rendersDir = (videoId: string) => path.join(process.cwd(), 'storage', 'renders', videoId);

/**
 * The video's thumbnails: candidate frames from its clean shots, three picked and worded by the
 * LLM when it can see images (evenly spread frames and the title's words otherwise), rendered in
 * the video's style into storage/renders/<id>/thumbnails.
 */
export async function generateThumbnails(options: {
  videoId: string;
  timeline: VideoTimeline;
  finalVideoPath: string;
  title: string;
  topic: string;
  narration: string;
  theme: MotionTheme;
  llm?: { provider: LLMProvider; ctx: ProviderCallContext } | null;
}): Promise<Thumbnail[]> {
  const { videoId, timeline, finalVideoPath, title, topic, narration, theme, llm } = options;
  const outDir = path.join(rendersDir(videoId), 'thumbnails');
  const framesDir = path.join(outDir, 'frames');
  await fs.rm(framesDir, { recursive: true, force: true });
  const frames = await extractFrames(await candidateMoments(timeline, finalVideoPath), framesDir);
  if (frames.length === 0) throw new Error('No frames could be taken from the video');

  let plans = fallbackPlans(frames.length, title);
  if (llm?.provider.supportsVision) {
    try {
      const picked = await planThumbnails({ frames, title, topic, narration, llm: llm.provider, ctx: llm.ctx });
      if (picked.length) plans = picked;
    } catch (err) {
      console.warn(`[Thumbnails] Vision picks unavailable; using evenly spread frames: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  }
  try {
    return await renderThumbnails({ plans, frames, theme, outDir });
  } finally {
    await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  }
}
