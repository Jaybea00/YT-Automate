import { NextResponse } from 'next/server';
import { removeFromLibrary } from '@/pipeline/visuals/clip-library';

/** Removes a clip from the library (videos already made with it keep their copy). */
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const removed = await removeFromLibrary(id);
  return removed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Clip not found' }, { status: 404 });
}
