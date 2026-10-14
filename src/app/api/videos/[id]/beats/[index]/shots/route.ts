import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadComposedBeat, publicShot } from '@/pipeline/visuals/shot-editor';

interface RouteContext {
  params: Promise<{ id: string; index: string }>;
}

/** The shots a composed beat is cut from, for the shot editor. */
export async function GET(_req: Request, context: RouteContext) {
  const { id: videoId, index } = await context.params;
  const beatIndex = Number.parseInt(index, 10);
  if (!videoId || !Number.isInteger(beatIndex) || beatIndex < 0) {
    return NextResponse.json({ error: 'Invalid video or beat' }, { status: 400 });
  }
  const beat = await loadComposedBeat(getSupabaseServerClient(), videoId, beatIndex);
  if (!beat) return NextResponse.json({ editable: false, shots: [] });
  return NextResponse.json({
    editable: true,
    shots: beat.shots.map(publicShot),
  });
}
