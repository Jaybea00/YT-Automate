import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { checkAssemblyGate } from '@/pipeline/assembly/gate';
import {
  addToOvernightQueue,
  inOvernightWindow,
  readOvernightQueue,
  releaseOvernightQueue,
  removeFromOvernightQueue,
  setOvernightWindow,
} from '@/pipeline/runner/overnight';

const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
const fail = (err: unknown, status = 500) =>
  NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });

/** The overnight queue, its window, and whether the window is open now. */
export async function GET() {
  const queue = await readOvernightQueue();
  return NextResponse.json({ ...queue, open: inOvernightWindow(new Date(), queue.window) });
}

/**
 * { videoId } holds a render for tonight (refused at once if a beat has no asset);
 * { action: 'start' } starts everything held now; { window: { start, end } } sets the hours.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      videoId?: string;
      action?: string;
      window?: { start?: string; end?: string };
    };
    const supabase = getSupabaseServerClient();
    if (body.action === 'start') {
      const result = await releaseOvernightQueue(supabase, { force: true });
      return NextResponse.json({ ...result, ...(await readOvernightQueue()) });
    }
    if (body.window) {
      return NextResponse.json(await setOvernightWindow(String(body.window.start), String(body.window.end)));
    }
    if (!validId(body.videoId)) return NextResponse.json({ error: 'Invalid or missing video ID' }, { status: 400 });

    const gate = await checkAssemblyGate(supabase, body.videoId);
    if (!gate.ready) return NextResponse.json({ error: gate.error, missingBeats: gate.missingBeats }, { status: gate.status });
    const { data: video } = await supabase.from('videos').select('title, topic').eq('id', body.videoId).maybeSingle();
    return NextResponse.json(await addToOvernightQueue(body.videoId, video?.title || video?.topic || 'Untitled'));
  } catch (err) {
    return fail(err);
  }
}

/** ?videoId= takes a render out of tonight's queue. */
export async function DELETE(req: Request) {
  const videoId = new URL(req.url).searchParams.get('videoId');
  if (!validId(videoId)) return NextResponse.json({ error: 'Invalid or missing video ID' }, { status: 400 });
  try {
    return NextResponse.json(await removeFromOvernightQueue(videoId));
  } catch (err) {
    return fail(err);
  }
}
