import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { addReviewNote, deleteReviewNote, listReviewNotes, updateReviewNote } from '@/pipeline/vibedit/review-notes';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const validId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);
const fail = (err: unknown) => NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });

/** The review notes, in video order. */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  try {
    return NextResponse.json({ notes: await listReviewNotes(getSupabaseServerClient(), id) });
  } catch (err) {
    return fail(err);
  }
}

/** { atSec, beat, text }: pins a note to a moment. */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  try {
    return NextResponse.json({ notes: await addReviewNote(getSupabaseServerClient(), id, (await req.json().catch(() => ({}))) ?? {}) });
  } catch (err) {
    return fail(err);
  }
}

/** { noteId, resolved?, text? }: ticks a note off (or back), or rewords it. */
export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { noteId?: unknown; resolved?: unknown; text?: unknown };
  if (typeof body.noteId !== 'string') return NextResponse.json({ error: 'Which note?' }, { status: 400 });
  try {
    return NextResponse.json({ notes: await updateReviewNote(getSupabaseServerClient(), id, body.noteId, body) });
  } catch (err) {
    return fail(err);
  }
}

/** ?noteId= removes a note. */
export async function DELETE(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const noteId = new URL(req.url).searchParams.get('noteId');
  if (!validId(id) || !noteId) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  try {
    return NextResponse.json({ notes: await deleteReviewNote(getSupabaseServerClient(), id, noteId) });
  } catch (err) {
    return fail(err);
  }
}
