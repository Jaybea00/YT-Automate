import { z } from 'zod';
import type { GeneratedScript, ScriptBeat } from './generate-script';
import { estimateSpeechSeconds } from './script-quality';

/**
 * A finished script handed in whole (written outside the app, e.g. by Claude in a chat): the
 * beats, their visuals and the titles. No AI call is needed to turn it into a video, so it works
 * when the script model is unavailable. It goes to script review like any other script.
 */

const VISUAL_TYPES = ['stock', 'archive', 'newspaper', 'geo_map', 'chart', 'screen_recording'] as const;

export const ReadyScriptSchema = z.object({
  title_options: z.array(z.string().trim().min(1).max(100)).min(1).max(8),
  beats: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(1200),
        visual_type: z.enum(VISUAL_TYPES).default('stock'),
        /** What the visual should show; defaults to the beat's own words. */
        visual_query: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(200),
  /** A Short's on-screen hook (2-6 words); defaults to the first title. */
  hook_banner: z.string().trim().max(80).optional(),
});
export type ReadyScript = z.infer<typeof ReadyScriptSchema>;

/** The ready script as the app's script, every beat numbered and timed. */
export function scriptFromReady(ready: ReadyScript): GeneratedScript {
  const beats: ScriptBeat[] = ready.beats.map((b, index) => ({
    index,
    text: b.text,
    visual_type: b.visual_type,
    visual_query: b.visual_query || b.text.split(/\s+/).slice(0, 8).join(' '),
    duration_estimate_seconds: Math.max(2, Math.round(estimateSpeechSeconds(b.text) * 10) / 10),
  }));
  return { title_options: ready.title_options, beats };
}
