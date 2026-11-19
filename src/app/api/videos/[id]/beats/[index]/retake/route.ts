import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { retakeBeat } from '@/pipeline/tts/retake';

interface RouteContext {
  params: Promise<{ id: string; index: string }>;
}

/**
 * Re-takes one beat whose voicing the listen-back check flagged: voices it again at slightly
 * different paces, checks each take, and keeps the best one if it's better than the current one.
 */
export async function POST(_req: Request, context: RouteContext) {
  const { id, index } = await context.params;
  const beatIndex = Number.parseInt(index, 10);
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isInteger(beatIndex) || beatIndex < 0) {
    return NextResponse.json({ error: 'Invalid video or beat' }, { status: 400 });
  }
  try {
    return NextResponse.json(await retakeBeat(getSupabaseServerClient(), id, beatIndex));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
