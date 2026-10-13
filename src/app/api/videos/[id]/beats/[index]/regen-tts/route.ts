import * as path from 'node:path';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { resolveTtsSetup, voiceBeat } from '@/pipeline/tts/voice-beat';

interface RouteContext {
  params: Promise<{ id: string; index: string }>;
}

/**
 * Re-voices a single beat, optionally with new narration, using the same narrator, delivery,
 * pronunciations, checkpointing and word timings as a full voicing run.
 * Body: { text?: string } — omit to re-voice the current narration.
 */
export async function handleRegenTts(req: Request, videoId: string, indexStr: string, supabaseClient?: SupabaseClient) {
  const beatIndex = Number.parseInt(indexStr, 10);
  if (!videoId || !Number.isInteger(beatIndex) || beatIndex < 0) {
    return NextResponse.json({ error: 'Invalid videoId or beatIndex' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const supabase = supabaseClient ?? getSupabaseServerClient();

  const { data: video, error: videoError } = await supabase
    .from('videos')
    .select('id, script_json')
    .eq('id', videoId)
    .maybeSingle();
  if (videoError || !video) {
    return NextResponse.json({ error: `Video ${videoId} not found` }, { status: 404 });
  }

  const scriptJson = video.script_json || {};
  const beats = Array.isArray(scriptJson.beats) ? [...scriptJson.beats] : [];
  const beat = beats[beatIndex];
  if (!beat) {
    return NextResponse.json({ error: `Beat ${beatIndex} does not exist in video script` }, { status: 404 });
  }

  const newText = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : beat.text;
  const { data: job } = await supabase
    .from('yt_jobs')
    .select('id, template, script, tts_provider_config_id')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!job?.id) {
    return NextResponse.json({ error: 'This video has not been voiced yet. Start voicing first.' }, { status: 400 });
  }

  // Keep the video, and the job's copy of the script, in step with the new narration
  if (newText !== beat.text) {
    // The shot plan's word ranges belong to the old narration
    beats[beatIndex] = { ...beat, text: newText, shots: undefined };
    await supabase.from('videos').update({ script_json: { ...scriptJson, beats } }).eq('id', videoId);

    const scenes = Array.isArray(job.script?.scenes) ? job.script.scenes : [];
    await supabase
      .from('yt_jobs')
      .update({
        script: {
          ...job.script,
          scenes: scenes.map((s: { scene_number: number }) => (s.scene_number === beatIndex ? { ...s, narration: newText } : s)),
        },
      })
      .eq('id', job.id);
  }

  const setup = await resolveTtsSetup(supabase, job);
  const result = await voiceBeat({
    supabase,
    setup,
    jobId: job.id,
    unitIndex: beatIndex,
    narration: newText,
    outputDir: path.join(process.cwd(), 'storage', 'jobs', job.id, 'audio'),
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error || 'Voicing failed' }, { status: 502 });
  }
  return NextResponse.json({
    success: true,
    beatIndex,
    text: newText,
    durationMs: result.durationMs,
    audioPath: result.outputPath,
    reused: result.skipped,
  });
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const { id, index } = await context.params;
    return await handleRegenTts(req, id, index);
  } catch (err) {
    console.error('[RegenTTS] Synthesis error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
