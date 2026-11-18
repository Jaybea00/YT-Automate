import { after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { composePack, savePack, withComposedStyle, type ComposedStyle, type StyleSetup } from '@/lib/styles/compose';
import { loadStyleLibrary } from '@/lib/styles/library';
import { isVideoStyle, withStyleDefaults, type VideoStyle } from '@/lib/styles/packs';
import { newCreationState, runCreation, type CreationRequest } from './create-video';
import { enqueueCreation } from './creation-queue';

/** Shared by the new-video routes (one video, a batch of topics, a retry). Server only. */

/** How a new video is styled: a format and niche (composed), or an original style id (older clients). */
export interface ResolvedStyle {
  /** For videos.style: the original style, or the closest one to the composed setup. */
  style: VideoStyle;
  composed: ComposedStyle | null;
}

export async function resolveNewVideoStyle(body: { setup?: Partial<StyleSetup> | null; style?: unknown }): Promise<ResolvedStyle> {
  if (body.setup && typeof body.setup === 'object') {
    const composed = composePack(body.setup, await loadStyleLibrary());
    return { style: composed.legacyStyle, composed };
  }
  return { style: isVideoStyle(body.style) ? body.style : 'tech', composed: null };
}

/** A new video's script_json with its style's starting settings (and its saved style, when composed). */
export function styledScript<T extends object>(scriptJson: T, resolved: ResolvedStyle): T {
  return resolved.composed ? withComposedStyle(scriptJson, resolved.composed) : withStyleDefaults(scriptJson, resolved.style);
}

/**
 * Creates a video waiting for its script and queues the writing in the background. Returns the
 * new row at once; the review page follows the writing from there.
 */
export async function createQueuedVideo(
  supabase: SupabaseClient,
  request: CreationRequest,
  resolved: ResolvedStyle,
): Promise<{ id: string } & Record<string, unknown>> {
  const styleFields = resolved.composed ? { style_setup: resolved.composed.setup, style_pack: savePack(resolved.composed.pack) } : {};
  const { data: video, error } = await supabase
    .from('videos')
    .insert({
      topic: request.topic,
      style: resolved.style,
      target_minutes: request.targetMinutes,
      status: 'scripting',
      script_json: { ...styleFields, creation: newCreationState(request) },
    })
    .select()
    .single();
  if (error || !video) throw new Error(`Failed to create video record: ${error?.message}`);
  startCreation(video.id);
  return video;
}

/** Queues a video's writing; kept running after the response is sent. */
export function startCreation(videoId: string): void {
  const done = enqueueCreation(videoId, () => runCreation(getSupabaseServerClient(), videoId));
  try {
    after(() => done);
  } catch {
    // Outside a request (a script or test): the queue runs on its own
  }
}

