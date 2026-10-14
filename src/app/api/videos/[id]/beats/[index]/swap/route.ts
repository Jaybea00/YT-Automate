import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import {
  getSafeUploadPath,
  deleteExistingBeatUploads,
  normalizeLicenseType,
  invalidateBeatAssemblyCache,
} from '@/pipeline/utils/media-upload';
import { upsertVideoAssetProvenance } from '@/pipeline/visuals/provenance';
import { downloadCandidateAsset } from '@/pipeline/visuals/media-aggregator';
import type { MediaCandidate } from '@/pipeline/visuals/types';

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
    const candidate: MediaCandidate | undefined = body.candidate;

    if (!candidate || !candidate.downloadUrl) {
      return NextResponse.json({ error: 'Valid candidate with downloadUrl is required' }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();

    // 1. Verify video exists
    const { data: video, error: videoError } = await supabase
      .from('videos')
      .select('id')
      .eq('id', videoId)
      .maybeSingle();

    if (videoError || !video) {
      return NextResponse.json({ error: `Video ${videoId} not found` }, { status: 404 });
    }

    // 2. Prepare safe destination file path
    const isVid = candidate.mediaType === 'video';
    const ext = isVid ? 'mp4' : 'jpg';

    // Clear old files for this beat to prevent conflicts
    await deleteExistingBeatUploads(videoId, beatIndex);

    const { filePath } = getSafeUploadPath(videoId, beatIndex, ext);

    // 3. Download the selected candidate
    console.log(`[Swap] Downloading candidate "${candidate.title}" (${candidate.provider}) to ${filePath}`);
    await downloadCandidateAsset(candidate, filePath);

    // 4. Determine final visual type
    const finalVisualType =
      candidate.provider === 'pixabay' || candidate.provider === 'pexels' ? 'stock' : 'archive';

    // 5. Update video_assets provenance record
    const normLicense = normalizeLicenseType(candidate.license);
    const attribution =
      candidate.attribution ||
      (normLicense === 'cc_by' ? `${candidate.title} via ${candidate.provider}` : null);

    await upsertVideoAssetProvenance(supabase, {
      video_id: videoId,
      beat_index: beatIndex,
      visual_type: finalVisualType,
      source_url: filePath,
      license_type: normLicense,
      license_source: candidate.provider,
      attribution_text: attribution,
      license_proof_url: candidate.licenseProofUrl || candidate.pageUrl || null,
      start_offset_seconds: 0,
      end_offset_seconds: null,
    });

    await invalidateBeatAssemblyCache(supabase, videoId, beatIndex);

    return NextResponse.json({
      success: true,
      swappedTo: {
        id: candidate.id,
        title: candidate.title,
        provider: candidate.provider,
        mediaType: candidate.mediaType,
        filePath,
      },
    });
  } catch (err) {
    console.error('[Swap] Error swapping beat candidate:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
