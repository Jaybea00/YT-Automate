import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { buildEditContext } from '@/pipeline/vibedit/chat-editor';
import { bulkCounts, readBulkStatus, startBulkFix } from '@/pipeline/vibedit/bulk-fix';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const validId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);

/** How many shots each bulk fix would change, and the latest bulk run's progress. */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  try {
    const counts = bulkCounts(await buildEditContext(getSupabaseServerClient(), id));
    return NextResponse.json({ counts, status: await readBulkStatus(id) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
  }
}

/** { kind: 'flagged' | 'text_cards' }: starts the bulk fix in the background. */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { kind?: unknown };
  if (body.kind !== 'flagged' && body.kind !== 'text_cards') return NextResponse.json({ error: 'Which fix?' }, { status: 400 });
  try {
    const { status } = await startBulkFix(getSupabaseServerClient(), id, body.kind);
    return NextResponse.json({ status }, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
