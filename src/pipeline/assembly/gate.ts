import type { SupabaseClient } from '@supabase/supabase-js';

export interface AssemblyGateResult {
  ready: boolean;
  missingBeats: number[];
  totalBeats: number;
  error?: string;
  status: number;
}

/**
 * Gate: assembly must refuse to start unless every beat has an asset.
 * Returns ready=false and status=400 listing the missing beat indexes if any beat lacks an asset.
 */
export async function checkAssemblyGate(
  supabase: SupabaseClient,
  videoId: string,
): Promise<AssemblyGateResult> {
  if (!videoId) {
    return {
      ready: false,
      missingBeats: [],
      totalBeats: 0,
      error: 'Video ID is required',
      status: 400,
    };
  }

  // 1. Fetch video script beats
  const { data: video, error: videoError } = await supabase
    .from('videos')
    .select('id, script_json')
    .eq('id', videoId)
    .maybeSingle();

  if (videoError || !video) {
    return {
      ready: false,
      missingBeats: [],
      totalBeats: 0,
      error: `Video "${videoId}" not found.`,
      status: 404,
    };
  }

  const beats = video.script_json?.beats;
  if (!Array.isArray(beats) || beats.length === 0) {
    return {
      ready: false,
      missingBeats: [],
      totalBeats: 0,
      error: 'Cannot start assembly: video does not have an approved script with beats.',
      status: 400,
    };
  }

  // 2. Query all assets for this video
  const { data: assets, error: assetsError } = await supabase
    .from('video_assets')
    .select('beat_index')
    .eq('video_id', videoId);

  if (assetsError) {
    return {
      ready: false,
      missingBeats: [],
      totalBeats: beats.length,
      error: `Failed to query video assets: ${assetsError.message}`,
      status: 500,
    };
  }

  const assetBeatIndices = new Set<number>((assets || []).map((a) => a.beat_index));
  const missingBeats: number[] = [];

  for (let i = 0; i < beats.length; i++) {
    if (!assetBeatIndices.has(i)) {
      missingBeats.push(i);
    }
  }

  if (missingBeats.length > 0) {
    return {
      ready: false,
      missingBeats,
      totalBeats: beats.length,
      error: `Assembly refused: missing visual assets for beats [${missingBeats.join(', ')}]. Every beat must have an asset before assembly can begin.`,
      status: 400,
    };
  }

  return {
    ready: true,
    missingBeats: [],
    totalBeats: beats.length,
    status: 200,
  };
}
