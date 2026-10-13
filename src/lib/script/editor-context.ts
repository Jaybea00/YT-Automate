import type { SupabaseClient } from '@supabase/supabase-js';
import type { EditorContext } from './script-editor';
import type { GeneratedScript, ScriptBeat } from './generate-script';
import type { VideoStyle } from './style-templates';

export interface LoadedEditorContext {
  context: EditorContext;
  script: GeneratedScript;
}

function isBeatLike(value: unknown): value is ScriptBeat {
  const b = value as ScriptBeat;
  return Boolean(b) && typeof b.text === 'string' && typeof b.visual_type === 'string';
}

/**
 * Builds the editing context for a video. When the review page sends its current beats
 * (which may include unsaved edits), those are used; topic, style, research, and target
 * length always come from the saved video.
 */
export async function loadEditorContext(
  supabase: SupabaseClient,
  videoId: string,
  clientBeats?: unknown,
): Promise<LoadedEditorContext | { error: string; status: number }> {
  const { data: video, error } = await supabase
    .from('videos')
    .select('id, topic, title, style, target_minutes, script_json')
    .eq('id', videoId)
    .single();

  if (error || !video) return { error: 'Video not found', status: 404 };
  const script = video.script_json as GeneratedScript | null;
  if (!script?.beats?.length) return { error: 'Video has no script to edit', status: 400 };

  const beats =
    Array.isArray(clientBeats) && clientBeats.length > 0 && clientBeats.every(isBeatLike)
      ? (clientBeats as ScriptBeat[]).map((b, index) => ({ ...b, index }))
      : script.beats;

  return {
    script,
    context: {
      beats,
      topic: video.topic || video.title || 'Video',
      style: (video.style as VideoStyle) || 'story_driven',
      research: script.research ?? null,
      targetMinutes: Number(video.target_minutes) || undefined,
    },
  };
}
