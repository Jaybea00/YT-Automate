import { NextResponse } from 'next/server';
import { fileResponse } from '@/lib/file-response';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadComposedBeat, shotClipPath } from '@/pipeline/visuals/shot-editor';
import { shotThumbnail } from '@/pipeline/visuals/storyboard';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** A still from the middle of one shot: ?beat=3&shot=1. */
export async function GET(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const url = new URL(req.url);
  const beatIndex = Number(url.searchParams.get('beat'));
  const shotIndex = Number(url.searchParams.get('shot'));
  if (!/^[\w-]+$/.test(id) || !Number.isInteger(beatIndex) || !Number.isInteger(shotIndex)) return new NextResponse('Invalid shot', { status: 400 });
  const beat = await loadComposedBeat(getSupabaseServerClient(), id, beatIndex);
  if (!beat?.shots[shotIndex]) return new NextResponse('Not found', { status: 404 });
  try {
    return fileResponse(req, await shotThumbnail(shotClipPath(beat.trackPath, beatIndex, shotIndex)));
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
