import { NextResponse } from 'next/server';
import { sendMomentToEditor } from '@/pipeline/hunter/handoff';

interface RouteContext {
  params: Promise<{ id: string; momentId: string }>;
}

/** Turns a hunted moment into a clip project (the Short editor); returns its id. */
export async function POST(_req: Request, context: RouteContext) {
  const { id, momentId } = await context.params;
  try {
    return NextResponse.json({ clipId: await sendMomentToEditor(id, momentId) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
