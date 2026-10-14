import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { subtitlesForVideo } from '@/pipeline/publish/subtitle-files';

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

  // 2. Timed to the narrator's words and real voice starts when the video has a timeline
  const result = await subtitlesForVideo(supabase, video);

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
