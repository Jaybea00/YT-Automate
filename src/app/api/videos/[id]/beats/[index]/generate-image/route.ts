import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getSafeUploadPath, deleteExistingBeatUploads, invalidateBeatAssemblyCache } from '@/pipeline/utils/media-upload';
import { upsertVideoAssetProvenance } from '@/pipeline/visuals/provenance';
import { generateAiVisualCandidate, downloadAndSaveAiImage } from '@/pipeline/visuals/ai-image-step';

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

    const body = await req.json().catch(() => ({}));
    const customPrompt: string | undefined = body.prompt;

    const supabase = getSupabaseServerClient();

    // 1. Fetch video and beat text
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
      `Cinematic documentary scene for beat ${beatIndex + 1}`;

    console.log(`[GenerateAI] Synthesizing AI visual for beat ${beatIndex}: "${prompt}"`);

    // 2. Generate candidate descriptor
    const candidate = await generateAiVisualCandidate({
      prompt,
      text: beat?.text,
    });

    // 3. Prepare upload path and download asset
    await deleteExistingBeatUploads(videoId, beatIndex);
    const { filePath } = getSafeUploadPath(videoId, beatIndex, 'jpg');

    await downloadAndSaveAiImage(candidate, filePath);

    // 4. Update video_assets and candidate store
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
      attribution_text: candidate.attribution || 'AI Generated Visual',
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
    console.error('[GenerateAI] Error generating AI visual:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
