import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getSafeUploadPath, deleteExistingBeatUploads, invalidateBeatAssemblyCache } from '@/pipeline/utils/media-upload';
import { upsertVideoAssetProvenance } from '@/pipeline/visuals/provenance';
import { generateAiMotionVideoCandidate, downloadAndSaveAiVideo } from '@/pipeline/visuals/ai-video-step';

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

    // 1. Check if video generation API key is configured (Google Veo direct or Fal)
    const googleKey =
      process.env.GOOGLE_VEO_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GEMINI_API_KEY;
    const falKey = process.env.FAL_KEY;

    if (!googleKey && !falKey) {
      return NextResponse.json(
        {
          error:
            'AI Video Generation is ready, but no API key is configured yet. Add either GOOGLE_VEO_API_KEY=your_key (or GEMINI_API_KEY) or FAL_KEY=your_key in your .env file to generate cinematic AI videos.',
          requiresKey: true,
          provider: 'google_veo_or_fal',
        },
        { status: 400 },
      );
    }


    const body = await req.json().catch(() => ({}));
    const customPrompt: string | undefined = body.prompt;
    // Passed through as sent (the step falls back to its default for an unknown model)
    const model = (body.model || 'veo2') as 'veo2' | 'kling' | 'minimax' | 'luma';

    const supabase = getSupabaseServerClient();

    // 2. Fetch video and beat text
    const { data: video, error: videoError } = await supabase
      .from('videos')
      .select('id, script_json')
      .eq('id', videoId)
      .maybeSingle();

    if (videoError || !video) {
      return NextResponse.json({ error: `Video ${videoId} not found` }, { status: 404 });
    }

    const beat = video.script_json?.beats?.[beatIndex];
    const prompt =
      customPrompt?.trim() ||
      beat?.visual_query?.trim() ||
      beat?.text?.trim() ||
      `Cinematic documentary motion footage for beat ${beatIndex + 1}`;

    console.log(`[GenerateVideo] Synthesizing AI motion video (${model}) for beat ${beatIndex}: "${prompt}"`);

    // 3. Generate candidate descriptor via Fal gateway
    const candidate = await generateAiMotionVideoCandidate({
      prompt,
      text: beat?.text,
      model,
      aspectRatio: '16:9',
      durationSeconds: 5,
    });

    // 4. Prepare upload path and download MP4 asset
    await deleteExistingBeatUploads(videoId, beatIndex);
    const { filePath } = getSafeUploadPath(videoId, beatIndex, 'mp4');

    await downloadAndSaveAiVideo(candidate.downloadUrl, filePath);

    // 5. Update video_assets and candidate store
    const { data: existingAsset } = await supabase
      .from('video_assets')
      .select('candidates_json')
      .eq('video_id', videoId)
      .eq('beat_index', beatIndex)
      .maybeSingle();

    const existingCandidates: Array<{ id?: unknown }> = existingAsset?.candidates_json || [];
    const updatedCandidates = [candidate, ...existingCandidates.filter((c) => c.id !== candidate.id)].slice(0, 6);

    await upsertVideoAssetProvenance(supabase, {
      video_id: videoId,
      beat_index: beatIndex,
      visual_type: 'uploaded',
      source_url: filePath,
      license_type: 'own_work',
      license_source: candidate.provider,
      attribution_text: candidate.attribution || 'AI Motion Video',
      license_proof_url: candidate.downloadUrl,
      start_offset_seconds: 0,
      end_offset_seconds: null,
      candidates_json: updatedCandidates,
    });

    await invalidateBeatAssemblyCache(supabase, videoId, beatIndex);

    return NextResponse.json({
      success: true,
      candidate,
      filePath,
    });
  } catch (err) {
    console.error('[GenerateVideo] Error generating AI video:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
