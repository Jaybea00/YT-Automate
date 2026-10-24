import type { SupabaseClient } from '@supabase/supabase-js';
import { readTimeline } from '../utils/timeline';

/**
 * Each beat's voice file, as the render will use it: from the last render's timeline, or (not
 * rendered yet, or a beat missing from it) the latest voicing of that beat.
 */
export async function voicePathsForVideo(
  supabase: SupabaseClient,
  videoId: string,
  scriptJson: unknown,
  beatCount: number,
): Promise<Map<number, string | null>> {
  const timeline = readTimeline(scriptJson as Record<string, unknown> | null);
  const audio = new Map<number, string | null>((timeline?.beats ?? []).map((b) => [b.index, b.audioPath]));
  if (audio.size < beatCount) {
    const { data: jobs } = await supabase.from('yt_jobs').select('id, created_at').eq('video_id', videoId).order('created_at', { ascending: false });
    for (const job of jobs ?? []) {
      const { data: units } = await supabase
        .from('yt_job_units')
        .select('unit_index, output_path')
        .eq('job_id', job.id)
        .eq('stage', 'tts')
        .eq('status', 'done');
      for (const u of units ?? []) if (!audio.has(u.unit_index) && u.output_path) audio.set(u.unit_index, u.output_path);
      if (audio.size >= beatCount) break;
    }
  }
  return audio;
}
