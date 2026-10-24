import * as fs from 'node:fs';
import { stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSafeWebStream } from '@/lib/streaming';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadComposedBeat, publicShot, shotClipPath } from '@/pipeline/visuals/shot-editor';
import { editShot } from '@/pipeline/visuals/shot-editor-actions';

interface RouteContext {
  params: Promise<{ id: string; index: string; shot: string }>;
}

async function load(context: RouteContext) {
  const { id: videoId, index, shot } = await context.params;
  const beatIndex = Number.parseInt(index, 10);
  const shotIndex = Number.parseInt(shot, 10);
  if (!videoId || !Number.isInteger(beatIndex) || beatIndex < 0 || !Number.isInteger(shotIndex) || shotIndex < 0) {
    return { error: NextResponse.json({ error: 'Invalid video, beat or shot' }, { status: 400 }) };
  }
  const supabase = getSupabaseServerClient();
  const beat = await loadComposedBeat(supabase, videoId, beatIndex);
  if (!beat || !beat.shots[shotIndex]) {
    return { error: NextResponse.json({ error: 'This beat has no editable shot there' }, { status: 404 }) };
  }
  return { supabase, videoId, beat, shotIndex };
}

/** The shot's clip, for previewing. */
export async function GET(req: Request, context: RouteContext) {
  const loaded = await load(context);
  if ('error' in loaded) return loaded.error;
  const file = shotClipPath(loaded.beat.trackPath, loaded.beat.beatIndex, loaded.shotIndex);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return new NextResponse('Shot clip not found', { status: 404 });
  const stream = createSafeWebStream(fs.createReadStream(file), { signal: req.signal });
  return new Response(stream, {
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(info.size), 'Cache-Control': 'no-cache' },
  });
}

const AlternativeSchema = z.object({
  id: z.string(),
  provider: z.string(),
  mediaType: z.enum(['video', 'image']),
  title: z.string().optional(),
  thumbnailUrl: z.string(),
  downloadUrl: z.string().url(),
  pageUrl: z.string().optional(),
  license: z.string().optional(),
  attribution: z.string().optional(),
  score: z.number().optional(),
});

const EditSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('swap'), candidate: AlternativeSchema }),
  z.object({ action: z.literal('redo') }),
  z.object({ action: z.literal('text') }),
  z.object({ action: z.literal('illustration'), prompt: z.string().max(400).optional() }),
]);

/** Replaces the shot: a chosen alternative, a fresh pick, or the narration as type. */
export async function POST(req: Request, context: RouteContext) {
  const loaded = await load(context);
  if ('error' in loaded) return loaded.error;
  const parsed = EditSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid edit' }, { status: 400 });
  try {
    const shot = await editShot({ ...loaded, edit: parsed.data });
    return NextResponse.json({ shot: publicShot(shot, loaded.shotIndex) });
  } catch (err) {
    console.error('[ShotEditor] Edit failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
