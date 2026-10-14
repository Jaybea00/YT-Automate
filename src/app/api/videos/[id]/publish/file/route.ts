import * as fs from 'node:fs';
import { stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { createSafeWebStream } from '@/lib/streaming';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadVideo, publishFilePath } from '@/pipeline/publish/publish-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** A thumbnail (?kind=thumbnail&n=1) or Short (?kind=short&n=1), for previewing or saving. */
export async function GET(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind');
  const n = Number.parseInt(url.searchParams.get('n') ?? '', 10);
  if ((kind !== 'thumbnail' && kind !== 'short') || !Number.isInteger(n) || n < 1) {
    return new NextResponse('Invalid file', { status: 400 });
  }
  const video = await loadVideo(getSupabaseServerClient(), id);
  const file = video ? publishFilePath(video, kind, n) : null;
  const info = file ? await stat(file).catch(() => null) : null;
  if (!file || !info?.isFile()) return new NextResponse('Not found', { status: 404 });
  const headers: Record<string, string> = {
    'Content-Type': kind === 'thumbnail' ? 'image/jpeg' : 'video/mp4',
    'Content-Length': String(info.size),
    'Cache-Control': 'no-cache',
  };
  if (url.searchParams.get('download') === '1') {
    headers['Content-Disposition'] = `attachment; filename="${kind}_${n}.${kind === 'thumbnail' ? 'jpg' : 'mp4'}"`;
  }
  return new Response(createSafeWebStream(fs.createReadStream(file), { signal: req.signal }), { headers });
}
