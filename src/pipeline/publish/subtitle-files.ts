import type { SupabaseClient } from '@supabase/supabase-js';
import { loadCaptionWords } from '../assembly/caption-sources';
import { applyCaptionEdits, type CaptionEdits } from '../assembly/caption-edits';
import { generateSubtitles, type BeatTimingLike, type SubtitlesResult, type UnitDurationLike } from '../utils/subtitles';
import { readTimeline } from '../utils/timeline';

/**
 * Subtitle files for a video: timed to the narrator's words and real voice starts when the video
 * has been rendered with a timeline, from voice lengths otherwise.
 */
export async function subtitlesForVideo(
  supabase: SupabaseClient,
  video: { id: string; script_json?: Record<string, unknown> | null },
): Promise<SubtitlesResult> {
  const script = (video.script_json ?? {}) as {
    beats?: BeatTimingLike[];
    scenes?: Array<{ scene_number: number; narration?: string; duration_estimate_seconds?: number }>;
  };
  const beats: BeatTimingLike[] =
    script.beats ||
    script.scenes?.map((s) => ({ index: s.scene_number, text: s.narration, duration_estimate_seconds: s.duration_estimate_seconds })) ||
    [];

  const { data: latestJob } = await supabase
    .from('yt_jobs')
    .select('id')
    .eq('video_id', video.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  let units: UnitDurationLike[] = [];
  if (latestJob?.id) {
    const { data } = await supabase
      .from('yt_job_units')
      .select('unit_index, duration_ms, stage, status')
      .eq('job_id', latestJob.id)
      .in('stage', ['tts', 'assembly']);
    units = data ?? [];
  }

  const timeline = readTimeline(video.script_json);
  const voiceStartMs = timeline ? Object.fromEntries(timeline.beats.map((b) => [b.index, b.voiceStartMs])) : undefined;
  const fileBeats = timeline
    ? timeline.beats.map((b) => ({ index: b.index, text: String(beats.find((x) => x.index === b.index)?.text ?? ''), audioPath: b.audioPath, durationSec: (b.voiceMs ?? 0) / 1000 }))
    : [];
  // Word fixes from the caption editor apply to the files too (hidden beats and styling don't)
  const words = timeline
    ? applyCaptionEdits(fileBeats, await loadCaptionWords(fileBeats), (video.script_json as { caption_edits?: CaptionEdits } | null)?.caption_edits, { forFiles: true })
    : undefined;
  return generateSubtitles({ beats, units, voiceStartMs, words });
}
