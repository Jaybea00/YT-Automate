import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadVideo, makeNativeShort, publishView } from '@/pipeline/publish/publish-service';

interface RouteContext {
  params: Promise<{ id: string; ideaId: string }>;
}

/** Writes one native Short and creates its mini video, ready for script review. */
export async function POST(_req: Request, context: RouteContext) {
  const { id, ideaId } = await context.params;
  const supabase = getSupabaseServerClient();
  const video = await loadVideo(supabase, id);
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  try {
    const shortVideoId = await makeNativeShort(supabase, video, ideaId);
    return NextResponse.json({ shortVideoId, view: await publishView(supabase, (await loadVideo(supabase, id))!) });
  } catch (err) {
    console.error('[Publish] native Short failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
