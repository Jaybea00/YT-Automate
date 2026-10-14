import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadComposedBeat } from '@/pipeline/visuals/shot-editor';
import { searchShotFootage } from '@/pipeline/visuals/shot-editor-actions';

interface RouteContext {
  params: Promise<{ id: string; index: string; shot: string }>;
}

const BodySchema = z.object({ query: z.string().trim().min(2).max(160) });

/** Footage for a custom search on one shot, best first. */
export async function POST(req: Request, context: RouteContext) {
  const { id: videoId, index, shot } = await context.params;
  const beatIndex = Number.parseInt(index, 10);
  const shotIndex = Number.parseInt(shot, 10);
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!videoId || !Number.isInteger(beatIndex) || !Number.isInteger(shotIndex) || !body.success) {
    return NextResponse.json({ error: 'Invalid search' }, { status: 400 });
  }
  const supabase = getSupabaseServerClient();
  const beat = await loadComposedBeat(supabase, videoId, beatIndex);
  if (!beat || !beat.shots[shotIndex]) {
    return NextResponse.json({ error: 'This beat has no editable shot there' }, { status: 404 });
  }
  try {
    const results = await searchShotFootage({ supabase, beat, shotIndex, query: body.data.query });
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
