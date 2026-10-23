import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { beatsToScenes } from '@/pipeline/utils/mapper';
import { stylePack, dramaticPauseSec } from '@/lib/styles/packs';
import type { ScriptBeat } from '@/lib/script/generate-script';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkAssemblyGate } from '@/pipeline/assembly/gate';

const ALLOWED_STAGES = [
  'research',
  'script',
  'image',
  'visuals',
  'tts',
  'assembly',
  'thumbnail',
  'metadata',
];

export async function handleVoiceRequest(
  req: Request,
  id: string,
  supabaseClient?: SupabaseClient,
) {
  try {
    let body: {
      stages?: string[];
      ttsProviderConfigId?: string;
      ttsProvider?: 'elevenlabs' | 'kokoro' | string;
      narratorId?: string;
    } = {};
    try {
      body = await req.json();
    } catch {
      // Empty or non-JSON body is acceptable; defaults will be used
    }

    // 1. Stage list validation (defaults to ['tts'])
    let targetStages: string[];
    if (body.stages !== undefined) {
      if (
        !Array.isArray(body.stages) ||
        body.stages.length === 0 ||
        body.stages.some((s) => typeof s !== 'string' || !ALLOWED_STAGES.includes(s))
      ) {
        return NextResponse.json(
          {
            error: `Invalid stages. Must be an array containing valid stage names: ${ALLOWED_STAGES.join(', ')}`,
          },
          { status: 400 },
        );
      }
      targetStages = body.stages;
    } else {
      targetStages = ['tts'];
    }

    const supabase = supabaseClient ?? getSupabaseServerClient();

    // 1b. Gate: assembly must refuse to start unless every beat has an asset
    if (targetStages.includes('assembly')) {
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
    }

    // 2. Validate optional TTS provider override (narratorId, ttsProviderConfigId, or ttsProvider)
    let targetTtsProviderConfigId: string | undefined;
    let targetVoiceId: string | undefined;
    let targetNarratorId: string | undefined;

    if (body.narratorId !== undefined) {
      if (typeof body.narratorId !== 'string' || !body.narratorId.trim()) {
        return NextResponse.json(
          { error: 'Invalid narratorId: must be a non-empty string UUID.' },
          { status: 400 },
        );
      }

      const { data: narrator, error: narratorError } = await supabase
        .from('narrators')
        .select('id, provider_config_id, voice_id, name')
        .eq('id', body.narratorId.trim())
        .maybeSingle();

      if (narratorError || !narrator) {
        return NextResponse.json(
          { error: `Narrator "${body.narratorId}" not found.` },
          { status: 400 },
        );
      }

      if (!narrator.provider_config_id) {
        return NextResponse.json(
          { error: `Narrator "${body.narratorId}" does not have an associated provider config.` },
          { status: 400 },
        );
      }

      const { data: config, error: configError } = await supabase
        .from('yt_provider_configs')
        .select('id, kind, is_active')
        .eq('id', narrator.provider_config_id)
        .maybeSingle();

      if (configError || !config) {
        return NextResponse.json(
          { error: `Provider config for narrator "${body.narratorId}" not found.` },
          { status: 400 },
        );
      }

      if (config.kind !== 'tts') {
        return NextResponse.json(
          { error: `Provider config for narrator "${body.narratorId}" is not a TTS provider.` },
          { status: 400 },
        );
      }

      if (!config.is_active) {
        return NextResponse.json(
          { error: `Provider config for narrator "${body.narratorId}" is inactive.` },
          { status: 400 },
        );
      }

      targetTtsProviderConfigId = config.id;
      targetVoiceId = narrator.voice_id;
      targetNarratorId = narrator.id;
    } else if (body.ttsProviderConfigId !== undefined) {
      if (typeof body.ttsProviderConfigId !== 'string' || !body.ttsProviderConfigId.trim()) {
        return NextResponse.json(
          { error: 'Invalid ttsProviderConfigId: must be a non-empty string UUID.' },
          { status: 400 },
        );
      }
      const { data: config, error: configError } = await supabase
        .from('yt_provider_configs')
        .select('id, kind, is_active')
        .eq('id', body.ttsProviderConfigId.trim())
        .maybeSingle();

      if (configError || !config) {
        return NextResponse.json(
          { error: `Provider config "${body.ttsProviderConfigId}" not found.` },
          { status: 400 },
        );
      }
      if (config.kind !== 'tts') {
        return NextResponse.json(
          {
            error: `Provider config "${body.ttsProviderConfigId}" is of kind "${config.kind}", expected "tts".`,
          },
          { status: 400 },
        );
      }
      if (!config.is_active) {
        return NextResponse.json(
          { error: `Provider config "${body.ttsProviderConfigId}" is inactive.` },
          { status: 400 },
        );
      }
      targetTtsProviderConfigId = config.id;
    } else if (body.ttsProvider !== undefined) {
      const providerSlug = String(body.ttsProvider).toLowerCase().trim();
      if (providerSlug !== 'elevenlabs' && providerSlug !== 'kokoro') {
        return NextResponse.json(
          { error: `Invalid ttsProvider: "${body.ttsProvider}". Must be 'elevenlabs' or 'kokoro'.` },
          { status: 400 },
        );
      }

      const targetAdapter = providerSlug === 'kokoro' ? 'openai-compatible' : 'elevenlabs';
      const { data: config, error: configError } = await supabase
        .from('yt_provider_configs')
        .select('id, kind, is_active')
        .eq('kind', 'tts')
        .eq('provider', targetAdapter)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (configError || !config) {
        return NextResponse.json(
          { error: `No active TTS provider config found for provider "${body.ttsProvider}".` },
          { status: 400 },
        );
      }
      targetTtsProviderConfigId = config.id;
    }

    // 3. Fetch video details
    const { data: video, error: videoError } = await supabase
      .from('videos')
      .select('*')
      .eq('id', id)
      .single();

    if (videoError || !video) {
      return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    }

    // 4. Validate script and beats
    // Accepts videos with status 'voicing', 'script_review', 'failed', or 'rendered' as long as approved beats exist
    const beats: ScriptBeat[] = video.script_json?.beats ?? [];
    if (!Array.isArray(beats) || beats.length === 0) {
      return NextResponse.json(
        { error: 'Cannot trigger voicing: video does not have an approved script with beats.' },
        { status: 400 },
      );
    }

    // 5. Check latest job for this video
    const { data: latestJob } = await supabase
      .from('yt_jobs')
      .select('id, status, created_at, stages, script, script_fingerprint')
      .eq('video_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Case A: Active job already running or queued -> return it
    if (latestJob && (latestJob.status === 'queued' || latestJob.status === 'running')) {
      return NextResponse.json(
        {
          jobId: latestJob.id,
          status: latestJob.status,
          resumed: true,
          message: 'An active pipeline job is already in progress for this video.',
        },
        { status: 200 },
      );
    }

    // Case B: Latest job failed or was cancelled -> re-queue the SAME job to reuse completed units.
    // Its scenes are refreshed from the current beats, so edits made after the failure are voiced;
    // unchanged beats still hit their unit checkpoints and aren't re-synthesized.
    if (latestJob && (latestJob.status === 'failed' || latestJob.status === 'cancelled')) {
      const { scenes: currentScenes, scriptFingerprint: currentFingerprint } = beatsToScenes(beats);
      const updatedScript = {
        ...(latestJob.script ?? {}),
        scenes: currentScenes,
        ...(targetTtsProviderConfigId !== undefined
          ? { tts_provider_config_id: targetTtsProviderConfigId }
          : {}),
        ...(targetVoiceId !== undefined
          ? { voice_id: targetVoiceId, voice_override: targetVoiceId }
          : {}),
        ...(targetNarratorId !== undefined
          ? { narrator_id: targetNarratorId }
          : {}),
      };

      const { error: requeueError } = await supabase
        .from('yt_jobs')
        .update({
          status: 'queued',
          error: null,
          stages: targetStages,
          script: updatedScript,
          script_fingerprint: currentFingerprint,
          updated_at: new Date().toISOString(),
        })
        .eq('id', latestJob.id);

      if (requeueError) {
        return NextResponse.json(
          { error: `Failed to re-queue job: ${requeueError.message}` },
          { status: 500 },
        );
      }

      // A stage marked done would be skipped wholesale; reset the requested ones so their
      // units are re-checked against the refreshed scenes
      for (const stage of targetStages) {
        await supabase
          .from('yt_job_stages')
          .update({ status: 'pending', error: null })
          .eq('job_id', latestJob.id)
          .eq('stage', stage);
      }

      const videoUpdates: Record<string, unknown> = { status: 'voicing', error_message: null };
      if (targetNarratorId) {
        videoUpdates.narrator_id = targetNarratorId;
      }

      await supabase
        .from('videos')
        .update(videoUpdates)
        .eq('id', id);

      return NextResponse.json(
        {
          jobId: latestJob.id,
          status: 'queued',
          resumed: true,
          ttsProviderConfigId: targetTtsProviderConfigId ?? null,
          voiceId: targetVoiceId ?? null,
          narratorId: targetNarratorId ?? null,
          message: 'Existing failed/cancelled job re-queued.',
        },
        { status: 200 },
      );
    }

    // Case B2: Latest job finished, but without some requested stages (e.g. it only voiced), and
    // the script and voice are unchanged -> add the missing stages to that SAME job, so the next
    // stage uses its completed voicing instead of a new job re-synthesizing every beat
    if (latestJob && latestJob.status === 'done') {
      const done = (latestJob.stages ?? []) as string[];
      const missing = targetStages.filter((s) => !done.includes(s));
      const { scriptFingerprint: currentFingerprint } = beatsToScenes(beats);
      const previous = (latestJob.script ?? {}) as Record<string, unknown>;
      const sameVoice =
        (targetNarratorId === undefined || targetNarratorId === previous.narrator_id) &&
        (targetVoiceId === undefined || targetVoiceId === previous.voice_id) &&
        (targetTtsProviderConfigId === undefined || targetTtsProviderConfigId === previous.tts_provider_config_id);
      if (missing.length > 0 && latestJob.script_fingerprint === currentFingerprint && sameVoice) {
        const { error: extendError } = await supabase
          .from('yt_jobs')
          .update({
            status: 'queued',
            error: null,
            stages: [...done, ...missing],
            updated_at: new Date().toISOString(),
          })
          .eq('id', latestJob.id);

        if (extendError) {
          return NextResponse.json({ error: `Failed to extend job: ${extendError.message}` }, { status: 500 });
        }

        await supabase.from('videos').update({ status: 'voicing', error_message: null }).eq('id', id);

        return NextResponse.json(
          {
            jobId: latestJob.id,
            status: 'queued',
            resumed: true,
            addedStages: missing,
            message: `Finished job extended with ${missing.join(', ')}; its completed stages are reused.`,
          },
          { status: 200 },
        );
      }
    }

    // Case C: No job exists OR latest job was 'done' -> create a new job
    const { scenes, scriptFingerprint } = beatsToScenes(beats);

    const scriptData: Record<string, unknown> = {
      title: video.title,
      visual_style: video.style,
      scenes,
    };
    // Documentary pacing is fixed on the job, so the video keeps one pace even if the style changes
    const pacing = stylePack(video.style)?.narration;
    if (pacing) scriptData.narration_pacing = pacing;
    // Pacing marks ("…") get a real pause; fixed on the job like the pacing
    scriptData.dramatic_pause_sec = dramaticPauseSec(video.style);
    if (targetTtsProviderConfigId) {
      scriptData.tts_provider_config_id = targetTtsProviderConfigId;
    }
    if (targetVoiceId) {
      scriptData.voice_id = targetVoiceId;
      scriptData.voice_override = targetVoiceId;
    }
    if (targetNarratorId) {
      scriptData.narrator_id = targetNarratorId;
    }

    const { data: newJob, error: insertError } = await supabase
      .from('yt_jobs')
      .insert({
        video_id: id,
        topic: video.topic || video.title || 'Untitled',
        template: video.style || 'tech-explainer',
        status: 'queued',
        stages: targetStages,
        script: scriptData,
        script_fingerprint: scriptFingerprint,
      })
      .select()
      .single();

    if (insertError) {
      // Handle race condition caught by the partial unique index
      if (insertError.code === '23505') {
        const { data: racedJob } = await supabase
          .from('yt_jobs')
          .select('id, status, created_at, stages')
          .eq('video_id', id)
          .in('status', ['queued', 'running'])
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (racedJob) {
          return NextResponse.json(
            {
              jobId: racedJob.id,
              status: racedJob.status,
              resumed: true,
              message: 'An active pipeline job was just created for this video.',
            },
            { status: 200 },
          );
        }
      }

      return NextResponse.json(
        { error: `Failed to create job: ${insertError.message}` },
        { status: 500 },
      );
    }

    // Ensure video status reflects voicing and clears prior error
    const videoUpdates: Record<string, unknown> = { status: 'voicing', error_message: null };
    if (targetNarratorId) {
      videoUpdates.narrator_id = targetNarratorId;
    }

    await supabase
      .from('videos')
      .update(videoUpdates)
      .eq('id', id);

    return NextResponse.json(
      {
        jobId: newJob.id,
        status: newJob.status,
        resumed: false,
        ttsProviderConfigId: targetTtsProviderConfigId ?? null,
        voiceId: targetVoiceId ?? null,
        narratorId: targetNarratorId ?? null,
        message: 'Pipeline voicing job created successfully.',
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;
  return handleVoiceRequest(req, id);
}
