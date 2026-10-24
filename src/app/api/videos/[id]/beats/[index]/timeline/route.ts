import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { beatTimelineView, moveCut, reorderShots } from '@/pipeline/vibedit/beat-timeline';

interface RouteContext {
  params: Promise<{ id: string; index: string }>;
}

async function parse(context: RouteContext) {
  const { id, index } = await context.params;
  const beat = Number.parseInt(index, 10);
  return /^[a-zA-Z0-9_-]+$/.test(id) && Number.isInteger(beat) && beat >= 0 ? { id, beat } : null;
}

/** The beat's shots over its narration's waveform and words. */
export async function GET(_req: Request, context: RouteContext) {
  const p = await parse(context);
  if (!p) return NextResponse.json({ error: 'Invalid video or beat' }, { status: 400 });
  try {
    return NextResponse.json(await beatTimelineView(getSupabaseServerClient(), p.id, p.beat));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

/** { action: 'reorder', order } | { action: 'move_cut', cut, deltaFrames } */
export async function POST(req: Request, context: RouteContext) {
  const p = await parse(context);
  if (!p) return NextResponse.json({ error: 'Invalid video or beat' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; order?: unknown; cut?: unknown; deltaFrames?: unknown };
  const supabase = getSupabaseServerClient();
  try {
    if (body.action === 'reorder' && Array.isArray(body.order)) {
      return NextResponse.json(await reorderShots(supabase, p.id, p.beat, body.order.map(Number)));
    }
    if (body.action === 'move_cut' && Number.isInteger(body.cut) && Number.isFinite(Number(body.deltaFrames))) {
      return NextResponse.json(await moveCut(supabase, p.id, p.beat, body.cut as number, Number(body.deltaFrames)));
    }
    return NextResponse.json({ error: 'Unknown change' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
