import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import {
  generateSubtitles,
  type BeatTimingLike,
  type UnitDurationLike,
} from '@/pipeline/utils/subtitles';

export async function handleGetSubtitles(
  req: Request,
  id: string,
  supabaseClient?: SupabaseClient,
) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return new NextResponse('Invalid video ID', { status: 400 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();

  // 1. Fetch video
  const { data: video, error: videoError } = await supabase
    .from('videos')
    .select('id, title, status, script_json')
    .eq('id', id)
    .maybeSingle();

  if (videoError || !video) {
    return new NextResponse('Video not found', { status: 404 });
  }

  const url = new URL(req.url, 'http://localhost');
  const format = (url.searchParams.get('format') || 'srt').toLowerCase();
  const isDownload = url.searchParams.get('download') === '1' || url.searchParams.get('download') === 'true';

  // 2. Extract beats from script_json
  const beats: BeatTimingLike[] =
    video.script_json?.beats ||
    video.script_json?.scenes?.map((s: { scene_number: number; narration?: string; duration_estimate_seconds?: number }) => ({
      index: s.scene_number,
      text: s.narration,
      duration_estimate_seconds: s.duration_estimate_seconds,
    })) ||
    [];

  // 3. Fetch latest job units for real measured duration_ms
  const { data: latestJob } = await supabase
    .from('yt_jobs')
    .select('id')
    .eq('video_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let units: UnitDurationLike[] = [];
  if (latestJob?.id) {
    const { data: jobUnits } = await supabase
      .from('yt_job_units')
      .select('unit_index, duration_ms, stage, status')
      .eq('job_id', latestJob.id)
      .in('stage', ['tts', 'assembly']);

    if (jobUnits) {
      units = jobUnits;
    }
  }

  const result = generateSubtitles({ beats, units });

  const safeTitle = (video.title || 'subtitles')
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '_');

  if (format === 'vtt') {
    const headers: Record<string, string> = {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    };
    if (isDownload) {
      headers['Content-Disposition'] = `attachment; filename="${safeTitle}.vtt"`;
    }
    return new NextResponse(result.vtt, { status: 200, headers });
  }

  // Default: SRT
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  };
  if (isDownload) {
    headers['Content-Disposition'] = `attachment; filename="${safeTitle}.srt"`;
  }
  return new NextResponse(result.srt, { status: 200, headers });
}

export async function GET(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;
  return handleGetSubtitles(req, id);
}
