import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadVideo, publishView, scorePackagingForVideo } from '@/pipeline/publish/publish-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Scores every title with every thumbnail against the niche's top videos. */
export async function POST(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  const supabase = getSupabaseServerClient();
  const video = await loadVideo(supabase, id);
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  try {
    await scorePackagingForVideo(supabase, video);
    return NextResponse.json(await publishView(supabase, (await loadVideo(supabase, id))!));
  } catch (err) {
    console.error('[Publish] packaging score failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
