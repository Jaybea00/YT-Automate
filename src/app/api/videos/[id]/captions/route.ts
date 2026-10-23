import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { captionEditorBeats, saveCaptionEdit } from '@/pipeline/assembly/caption-editor-data';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const validId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);

/** Every beat's caption words and the creator's edits (Vibedit's caption editor). */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  try {
    return NextResponse.json({ beats: await captionEditorBeats(getSupabaseServerClient(), id) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
  }
}

/** { beat, edit }: saves one beat's caption edit (edit null removes it). Applies on the next render. */
export async function PUT(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { beat?: unknown; edit?: unknown } | null;
  if (!body || !Number.isInteger(body.beat) || (body.beat as number) < 0) return NextResponse.json({ error: 'Which beat?' }, { status: 400 });
  try {
    return NextResponse.json({ beat: await saveCaptionEdit(getSupabaseServerClient(), id, body.beat as number, body.edit ?? null) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
