import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { createShorts, loadVideo, publishView } from '@/pipeline/publish/publish-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Shorts, generated afresh. { reframe: false } keeps the whole picture in every shot. */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const supabase = getSupabaseServerClient();
  const video = await loadVideo(supabase, id);
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  try {
    const body = (await req.json().catch(() => ({}))) as { reframe?: boolean };
    await createShorts(supabase, video, { reframe: body?.reframe !== false });
    return NextResponse.json(await publishView(supabase, (await loadVideo(supabase, id))!));
  } catch (err) {
    console.error('[Publish] shorts failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
