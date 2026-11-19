import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { readWatchStatus, startWatchThrough } from '@/pipeline/vibedit/watch-through';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const validId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);

/** The AI watch-through's progress (or its last result). */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  return NextResponse.json({ status: await readWatchStatus(id) });
}

/** Starts the AI watch-through in the background. */
export async function POST(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  try {
    return NextResponse.json({ status: await startWatchThrough(getSupabaseServerClient(), id) }, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
