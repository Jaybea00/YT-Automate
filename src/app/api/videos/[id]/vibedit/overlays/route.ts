import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { addOverlay, deleteOverlay, listOverlays, updateOverlay } from '@/pipeline/vibedit/overlays-store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const validId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);
const fail = (err: unknown) => NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });

/** The creator's text, callouts and arrows. */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  try {
    return NextResponse.json({ overlays: await listOverlays(getSupabaseServerClient(), id) });
  } catch (err) {
    return fail(err);
  }
}

/** { kind, beat, offsetSec, durationSec, text, x, y }: adds one (shown on the next render or preview). */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  try {
    return NextResponse.json({ overlays: await addOverlay(getSupabaseServerClient(), id, await req.json().catch(() => ({}))) });
  } catch (err) {
    return fail(err);
  }
}

/** { overlayId, ...fields }: changes one. */
export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { overlayId?: unknown };
  if (typeof body.overlayId !== 'string') return NextResponse.json({ error: 'Which overlay?' }, { status: 400 });
  try {
    return NextResponse.json({ overlays: await updateOverlay(getSupabaseServerClient(), id, body.overlayId, body) });
  } catch (err) {
    return fail(err);
  }
}

/** ?overlayId= removes one. */
export async function DELETE(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const overlayId = new URL(req.url).searchParams.get('overlayId');
  if (!validId(id) || !overlayId) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  try {
    return NextResponse.json({ overlays: await deleteOverlay(getSupabaseServerClient(), id, overlayId) });
  } catch (err) {
    return fail(err);
  }
}
