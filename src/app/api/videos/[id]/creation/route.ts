import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { isCreationRequest, newCreationState, type CreationState } from '@/lib/script/create-video';
import { creationQueueStatus } from '@/lib/script/creation-queue';
import { startCreation } from '@/lib/script/new-video';

/**
 * Where a new video's background writing stands: being written, waiting (and behind how many), or
 * unknown to the queue (lost when the server restarted, so it can be retried).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(creationQueueStatus(id));
}

/** Tries the writing again from the request saved on the video (after a failure, or when it was lost). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const queue = creationQueueStatus(id);
  if (queue.active || queue.queued) return NextResponse.json({ error: 'This video is already being written.' }, { status: 409 });

  const supabase = getSupabaseServerClient();
  const { data: video } = await supabase.from('videos').select('id, status, script_json').eq('id', id).maybeSingle();
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  const sj = (video.script_json ?? {}) as { creation?: CreationState; beats?: unknown[] } & Record<string, unknown>;
  const request = sj.creation?.request;
  if (!isCreationRequest(request)) return NextResponse.json({ error: 'This video has no saved request to retry; create it again.' }, { status: 400 });
  if (Array.isArray(sj.beats) && sj.beats.length) return NextResponse.json({ error: 'This video already has a script.' }, { status: 400 });
  if (video.status !== 'failed' && video.status !== 'scripting') {
    return NextResponse.json({ error: 'Only a video whose writing failed or stopped can be retried.' }, { status: 400 });
  }

  const { creation: _old, ...rest } = sj;
  void _old;
  const { error } = await supabase
    .from('videos')
    .update({
      status: 'scripting',
      error_message: null,
      script_json: { ...rest, creation: newCreationState(request, (sj.creation?.attempts ?? 1) + 1) },
    })
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  startCreation(id);
  return NextResponse.json({ ok: true }, { status: 202 });
}
