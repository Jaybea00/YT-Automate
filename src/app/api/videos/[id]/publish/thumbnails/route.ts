import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { regenerateThumbnails, loadVideo, publishView } from '@/pipeline/publish/publish-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Thumbnails, generated afresh. */
export async function POST(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const supabase = getSupabaseServerClient();
  const video = await loadVideo(supabase, id);
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  try {
    await regenerateThumbnails(supabase, video);
    return NextResponse.json(await publishView(supabase, (await loadVideo(supabase, id))!));
  } catch (err) {
    console.error('[Publish] thumbnails failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
