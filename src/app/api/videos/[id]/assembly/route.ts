import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { queueAssemblyJob } from '@/pipeline/runner/overnight';

export async function handleAssemblyRequest(
  req: Request,
  id: string,
  supabaseClient?: SupabaseClient,
) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: 'Invalid or missing video ID' }, { status: 400 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();
  // A quick low-resolution preview: the video's status and finished render stay as they are
  const body = (await req.clone().json().catch(() => ({}))) as { draft?: boolean; beats?: unknown };
  const draft = body?.draft === true;
  // A preview may cover chosen beats only
  const beats = Array.isArray(body?.beats) ? body.beats.filter((n): n is number => Number.isInteger(n) && n >= 0).slice(0, 50) : undefined;

  // The assembly gate (every beat needs an asset), then a pipeline job targeting ['assembly']
  const result = await queueAssemblyJob(supabase, id, { draft, beats });
  if (!result.ok) {
    return NextResponse.json(
      result.missingBeats
        ? { error: result.error, missingBeats: result.missingBeats, totalBeats: result.totalBeats }
        : { error: result.error },
      { status: result.status },
    );
  }

  return NextResponse.json(
    {
      jobId: result.jobId,
      status: 'queued',
      message: draft ? 'Preview queued.' : 'Assembly job queued successfully.',
    },
    { status: 201 },
  );
}

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await props.params;
    return await handleAssemblyRequest(req, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
