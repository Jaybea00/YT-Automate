import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { listSnapshots, restoreSnapshot } from '@/pipeline/vibedit/chat-editor';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The chat edits that can still be undone, newest first. */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  return NextResponse.json({ snapshots: await listSnapshots(id) });
}

/** { snapshotId }: puts those beats back as they were before the chat edit. */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { snapshotId?: unknown };
  if (typeof body.snapshotId !== 'string') return NextResponse.json({ error: 'Which edit to undo?' }, { status: 400 });
  try {
    const beats = await restoreSnapshot(getSupabaseServerClient(), id, body.snapshotId);
    return NextResponse.json({ restored: beats, snapshots: await listSnapshots(id) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
