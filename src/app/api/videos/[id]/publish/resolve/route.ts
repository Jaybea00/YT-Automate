import { PassThrough, Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadVideo } from '@/pipeline/publish/publish-service';
import { prepareResolveExport, writeResolveZip } from '@/pipeline/publish/resolve-export';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The edit for DaVinci Resolve: timeline, picture, narration, music, effects and captions, as a zip. */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const supabase = getSupabaseServerClient();
  const video = await loadVideo(supabase, id);
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  let dir: string;
  try {
    dir = await prepareResolveExport(supabase, video);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  const stream = new PassThrough();
  writeResolveZip(dir, stream).catch((err) => {
    console.error('[Publish] Resolve export failed:', err);
    stream.destroy(err instanceof Error ? err : new Error(String(err)));
  });
  const name = (video.title || 'video').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'video';
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}_resolve.zip"` },
  });
}
