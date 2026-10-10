import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { TTSProvider } from '@/pipeline/providers/types';
import { getAudioDurationMs } from '@/pipeline/utils/ffmpeg';

interface RouteContext {
  params: Promise<{ id: string; index: string }>;
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const { id: videoId, index: indexStr } = await context.params;
    const beatIndex = parseInt(indexStr, 10);

    if (!videoId || isNaN(beatIndex) || beatIndex < 0) {
      return NextResponse.json({ error: 'Invalid videoId or beatIndex' }, { status: 400 });
    }

    const body = await req.json();
    const newText = (body.text || '').trim();

    if (!newText) {
      return NextResponse.json({ error: 'Narration text cannot be empty' }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();

    // 1. Fetch video and current script
    const { data: video, error: videoError } = await supabase
      .from('videos')
      .select('id, script_json')
      .eq('id', videoId)
      .maybeSingle();

    if (videoError || !video) {
      return NextResponse.json({ error: `Video ${videoId} not found` }, { status: 404 });
    }

    const scriptJson = video.script_json || {};
    const beats = scriptJson.beats || [];
    if (!beats[beatIndex]) {
      return NextResponse.json({ error: `Beat ${beatIndex} does not exist in video script` }, { status: 404 });
    }

    // 2. Update text in script_json
    beats[beatIndex].text = newText;
    scriptJson.beats = beats;

    await supabase
      .from('videos')
      .update({ script_json: scriptJson })
      .eq('id', videoId);

    // 3. Find latest job for this video
    const { data: job } = await supabase
      .from('yt_jobs')
      .select('id, tts_provider_config_id')
      .eq('video_id', videoId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const jobId = job?.id || 'manual_regen';
    const outputDir = path.join(process.cwd(), 'storage', 'jobs', jobId, 'audio');
    await fs.mkdir(outputDir, { recursive: true });
    const audioPath = path.join(outputDir, `tts_scene_${beatIndex}.mp3`);

    // 4. Resolve TTS provider and synthesize
    const { provider, ctx, options } = await resolveForStage<TTSProvider>(
      'tts',
      supabase,
      job?.tts_provider_config_id,
    );

    const voiceId = (options.voiceId as string) || (options.voice as string) || 'alloy';

    const synthResult = await provider.synthesize(
      {
        text: newText,
        voiceId,
        format: 'mp3',
      },
      ctx,
    );

    await fs.writeFile(audioPath, Buffer.from(synthResult.bytes));
    const durationMs = synthResult.durationMs ?? (await getAudioDurationMs(audioPath));

    // 5. Update or insert yt_job_units
    if (job?.id) {
      const { data: existingUnit } = await supabase
        .from('yt_job_units')
        .select('id')
        .eq('job_id', job.id)
        .eq('stage', 'tts')
        .eq('unit_index', beatIndex)
        .maybeSingle();

      if (existingUnit) {
        await supabase
          .from('yt_job_units')
          .update({
            status: 'done',
            output_path: audioPath,
            duration_ms: durationMs,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingUnit.id);
      } else {
        await supabase.from('yt_job_units').insert({
          job_id: job.id,
          stage: 'tts',
          unit_index: beatIndex,
          status: 'done',
          output_path: audioPath,
          duration_ms: durationMs,
          input_hash: `manual_regen_${Date.now()}`,
        });
      }
    }

    return NextResponse.json({
      success: true,
      beatIndex,
      text: newText,
      durationMs,
      audioPath,
    });
  } catch (err) {
    console.error('[RegenTTS] Synthesis error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
