import { NextResponse } from 'next/server';
import { deleteLibraryItem, isLibraryKind } from '@/lib/styles/library';

/**
 * Deletes one of the creator's own formats, niches or voices. Videos already made with it keep
 * their style (each video saves the style it was made with).
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  if (!isLibraryKind(kind)) return NextResponse.json({ error: 'Unknown kind' }, { status: 404 });
  const { deleted } = await deleteLibraryItem(kind, id);
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
