import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enqueueHunt, isHuntBusy } from '@/pipeline/hunter/run';
import { deleteHunt, loadHunt, updateHunt } from '@/pipeline/hunter/store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const hunt = await loadHunt(id);
  if (!hunt) return NextResponse.json({ error: 'Hunt not found' }, { status: 404 });
  return NextResponse.json({ hunt, busy: isHuntBusy(id) });
}

const Edit = z.object({
  creator: z.string().max(80).optional(),
  /** Hide or bring back moments. */
  discard: z.record(z.string(), z.boolean()).optional(),
});

export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const parsed = Edit.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid edit' }, { status: 400 });
  if (!(await loadHunt(id))) return NextResponse.json({ error: 'Hunt not found' }, { status: 404 });
  const hunt = await updateHunt(id, (h) => {
    if (parsed.data.creator !== undefined) h.creator = parsed.data.creator.trim();
    for (const [momentId, discarded] of Object.entries(parsed.data.discard ?? {})) {
      const m = h.moments.find((x) => x.id === momentId);
      if (m) m.discarded = discarded;
    }
  });
  return NextResponse.json({ hunt });
}

/** Runs the hunt again: { from: "all" } from the download, "cut" to retry moments that failed to cut. */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = (await req.json().catch(() => ({}))) as { from?: string };
  if (!(await loadHunt(id))) return NextResponse.json({ error: 'Hunt not found' }, { status: 404 });
  if (isHuntBusy(id)) return NextResponse.json({ error: 'The hunt is already running' }, { status: 409 });
  const from = body.from === 'all' ? 'all' : 'cut';
  await updateHunt(id, (h) => {
    h.status = 'queued';
    h.step = 'Waiting to start';
    delete h.error;
  });
  enqueueHunt(id, from);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (isHuntBusy(id)) return NextResponse.json({ error: 'The hunt is still running' }, { status: 409 });
  return (await deleteHunt(id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Hunt not found' }, { status: 404 });
}
