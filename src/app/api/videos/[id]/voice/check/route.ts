import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { mapWithConcurrency } from '@/pipeline/tts/voice-beat';
import { loadVoiceCheck, resolveVoiceCheckContext, runVoiceCheck, type VoiceCheckResult } from '@/pipeline/tts/voice-check';

type BeatCheck = { beatIndex: number; result?: VoiceCheckResult; error?: string };

/** Latest voiced audio per beat across the video's jobs (newest job first). */
async function voicedBeats(supabase: SupabaseClient, videoId: string): Promise<Map<number, string>> {
  const { data: jobs } = await supabase
    .from('yt_jobs')
    .select('id')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false });
  const audio = new Map<number, string>();
  for (const job of jobs ?? []) {
    const { data: units } = await supabase
      .from('yt_job_units')
      .select('unit_index, output_path')
      .eq('job_id', job.id)
      .eq('stage', 'tts')
      .eq('status', 'done');
    for (const unit of units ?? []) {
      if (unit.output_path && !audio.has(unit.unit_index)) audio.set(unit.unit_index, unit.output_path);
    }
  }
  return audio;
}

async function loadContext(supabase: SupabaseClient, videoId: string) {
  const { data: video } = await supabase.from('videos').select('id, script_json').eq('id', videoId).maybeSingle();
  if (!video) return null;
  const beats: Array<{ text: string }> = video.script_json?.beats ?? [];
  return { beats, audio: await voicedBeats(supabase, videoId) };
}

/** Saved checks that still match each beat's current audio. */
export async function handleGetVoiceChecks(videoId: string, supabaseClient?: SupabaseClient) {
  const supabase = supabaseClient ?? getSupabaseServerClient();
  const loaded = await loadContext(supabase, videoId);
  if (!loaded) return NextResponse.json({ error: 'Video not found' }, { status: 404 });

  const checks: BeatCheck[] = [];
  for (const [beatIndex, audioPath] of loaded.audio) {
    const result = await loadVoiceCheck(audioPath);
    if (result) checks.push({ beatIndex, result });
  }
  return NextResponse.json({ checks: checks.sort((a, b) => a.beatIndex - b.beatIndex), voicedBeats: loaded.audio.size });
}

/** Runs the listen-back check. Body: { beatIndexes?: number[], force?: boolean } */
export async function handleRunVoiceChecks(req: Request, videoId: string, supabaseClient?: SupabaseClient) {
  const body = (await req.json().catch(() => ({}))) as { beatIndexes?: unknown; force?: unknown };
  const supabase = supabaseClient ?? getSupabaseServerClient();
  const loaded = await loadContext(supabase, videoId);
  if (!loaded) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  if (loaded.audio.size === 0) {
    return NextResponse.json({ error: 'No voiced beats to check yet.' }, { status: 400 });
  }

  const wanted = Array.isArray(body.beatIndexes)
    ? new Set(body.beatIndexes.filter((n): n is number => Number.isInteger(n)))
    : null;
  const targets = [...loaded.audio].filter(([beatIndex]) => !wanted || wanted.has(beatIndex));
  const ctx = await resolveVoiceCheckContext(supabase);

  const checks = await mapWithConcurrency(targets, 3, async ([beatIndex, audioPath]): Promise<BeatCheck> => {
    try {
      const narration = loaded.beats[beatIndex]?.text ?? '';
      return { beatIndex, result: await runVoiceCheck(audioPath, narration, ctx, { force: body.force === true }) };
    } catch (err) {
      return { beatIndex, error: err instanceof Error ? err.message : String(err) };
    }
  });

  return NextResponse.json({ checks: checks.sort((a, b) => a.beatIndex - b.beatIndex), voicedBeats: loaded.audio.size });
}

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params;
    return await handleGetVoiceChecks(id);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params;
    return await handleRunVoiceChecks(req, id);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}
