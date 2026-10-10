import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { checkAssemblyGate } from '@/pipeline/assembly/gate';
import { beatsToScenes } from '@/pipeline/utils/mapper';

export async function handleAssemblyRequest(
  req: Request,
  id: string,
  supabaseClient?: SupabaseClient,
) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: 'Invalid or missing video ID' }, { status: 400 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();

  // 1. Enforce Assembly Gate: must refuse to start unless every beat has an asset
  const gateResult = await checkAssemblyGate(supabase, id);
  if (!gateResult.ready) {
    return NextResponse.json(
      {
        error: gateResult.error,
        missingBeats: gateResult.missingBeats,
        totalBeats: gateResult.totalBeats,
      },
      { status: gateResult.status },
    );
  }

  // 2. Fetch video details
  const { data: video } = await supabase
    .from('videos')
    .select('*')
    .eq('id', id)
    .single();

  if (!video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const beats = video.script_json?.beats || [];
  const { scenes, scriptFingerprint } = beatsToScenes(beats);

  // 3. Create or reuse pipeline job targeting ['assembly'] stage
  const { data: newJob, error: jobError } = await supabase
    .from('yt_jobs')
    .insert({
      video_id: id,
      topic: video.topic || video.title || 'Untitled',
      template: video.style || 'tech-explainer',
      status: 'queued',
      stages: ['assembly'],
      script: {
        title: video.title,
        visual_style: video.style,
        scenes,
      },
      script_fingerprint: scriptFingerprint,
    })
    .select()
    .single();

  if (jobError) {
    return NextResponse.json(
      { error: `Failed to create assembly job: ${jobError.message}` },
      { status: 500 },
    );
  }

  await supabase
    .from('videos')
    .update({ status: 'rendering', error_message: null })
    .eq('id', id);

  return NextResponse.json(
    {
      jobId: newJob.id,
      status: 'queued',
      message: 'Assembly job queued successfully.',
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
