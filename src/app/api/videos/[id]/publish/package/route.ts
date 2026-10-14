import { PassThrough, Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadVideo, writePackage } from '@/pipeline/publish/publish-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The upload package as a zip: video, thumbnails, Shorts, subtitles and the text for YouTube Studio. */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const supabase = getSupabaseServerClient();
  const video = await loadVideo(supabase, id);
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  const stream = new PassThrough();
  writePackage(supabase, video, stream).catch((err) => {
    console.error('[Publish] Package failed:', err);
    stream.destroy(err instanceof Error ? err : new Error(String(err)));
  });
  const name = (video.title || 'video').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'video';
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}_youtube_package.zip"` },
  });
}
