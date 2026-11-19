import { NextResponse } from 'next/server';
import { fileResponse } from '@/lib/file-response';
import { listLibrary } from '@/pipeline/compile/library';

/** A library item's video or still: ?key=hunt:…:m03&kind=video|thumb. Only keys in the library are served. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  const item = key ? (await listLibrary()).find((i) => i.key === key) : null;
  if (!item) return new NextResponse('Not found', { status: 404 });
  const file = url.searchParams.get('kind') === 'thumb' ? item.thumb : item.file;
  return file ? fileResponse(req, file) : new NextResponse('Not found', { status: 404 });
}
