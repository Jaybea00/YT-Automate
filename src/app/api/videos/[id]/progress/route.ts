import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;

  try {
    const supabase = getSupabaseServerClient();

    // 1. Fetch video
    const { data: video, error: videoError } = await supabase
      .from('videos')
      .select('id, title, topic, status, render_url, error_message, script_json')
      .eq('id', id)
      .single();

    if (videoError || !video) {
      return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    }

    const url = new URL(_req.url);
    const requestedJobId = url.searchParams.get('jobId');

    // 2. Fetch all jobs for this video
    const { data: allJobs } = await supabase
      .from('yt_jobs')
      .select('*')
      .eq('video_id', id)
      .order('created_at', { ascending: false });

    const job = requestedJobId
      ? allJobs?.find((j) => j.id === requestedJobId) || allJobs?.[0] || null
      : allJobs?.find((j) => j.status === 'running' || j.status === 'queued') ||
        allJobs?.[0] ||
        null;

    // 3. Fetch video assets (provenance records)
    const { data: assets } = await supabase
      .from('video_assets')
      .select('id, video_id, beat_index, visual_type, source_url, license_type, license_source, attribution_text, license_proof_url, start_offset_seconds, end_offset_seconds, candidates_json, created_at')
      .eq('video_id', id)
      .order('beat_index', { ascending: true });

    if (!job) {
      return NextResponse.json({
        video,
        job: null,
        jobs: allJobs || [],
        stages: [],
        units: [],
        assets: assets || [],
      });
    }

    // 4. Fetch stage checkpoints
    const { data: stages } = await supabase
      .from('yt_job_stages')
      .select('*')
      .eq('job_id', job.id)
      .order('started_at', { ascending: true });

    // 5. Fetch unit checkpoints
    const { data: units } = await supabase
      .from('yt_job_units')
      .select('id, stage, unit_index, status, duration_ms, cost_usd, attempts, error, output_path, created_at, updated_at')
      .eq('job_id', job.id)
      .order('unit_index', { ascending: true });

    return NextResponse.json({
      video,
      job,
      jobs: allJobs || [],
      stages: stages || [],
      units: units || [],
      assets: assets || [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
