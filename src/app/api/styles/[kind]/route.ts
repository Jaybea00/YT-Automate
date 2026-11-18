import { NextResponse } from 'next/server';
import { isLibraryKind, upsertLibraryItem } from '@/lib/styles/library';

/** Saves one of the creator's own formats, niches or voices (new, or replacing the one with its id). */
export async function POST(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!isLibraryKind(kind)) return NextResponse.json({ error: 'Unknown kind' }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { item?: unknown } | null;
  try {
    const { item } = await upsertLibraryItem(kind, body?.item);
    return NextResponse.json({ item });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not save' }, { status: 400 });
  }
}
