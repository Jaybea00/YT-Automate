import { NextResponse } from 'next/server';
import { fileResponse } from '@/lib/file-response';
import { huntFile, loadHunt } from '@/pipeline/hunter/store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** A moment's clip or still: ?moment=m03&kind=video|thumb, with ?download=1 to save it. */
export async function GET(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const hunt = await loadHunt(id);
  const url = new URL(req.url);
  const moment = hunt?.moments.find((m) => m.id === url.searchParams.get('moment'));
  if (!hunt || !moment) return new NextResponse('Not found', { status: 404 });
  const relative = url.searchParams.get('kind') === 'thumb' ? moment.thumb : moment.file;
  if (!relative) return new NextResponse('Not found', { status: 404 });
  const ext = relative.split('.').pop() ?? 'mp4';
  return fileResponse(req, huntFile(id, relative), url.searchParams.get('download') === '1' ? `${moment.recipe}-${moment.id}.${ext}` : undefined);
}
