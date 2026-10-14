import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScriptBeat, ShotType } from '@/lib/script/generate-script';
import { loadWordTimings } from '../tts/word-timings';
import { MOTION_RENDERERS } from './motion-shots';
import { upsertVideoAssetProvenance } from './provenance';
import { composeBeatTrack, summarizeLicenses } from './shot-composer';
import { createShotRenderer, type ShotRenderContext, type TypedShotRenderer } from './shot-renderers';

export interface ComposeShotBeatOptions {
  supabase: SupabaseClient;
  videoId: string;
  beat: ScriptBeat;
  audioPath: string;
  audioDurationMs: number;
  outputDir: string;
  renderContext: Omit<ShotRenderContext, 'beatIndex' | 'downloadDir'>;
  typedRenderers?: Partial<Record<ShotType, TypedShotRenderer>>;
}

/** True when the user uploaded their own visual for the beat, which always takes precedence. */
export async function hasUploadedVisual(supabase: SupabaseClient, videoId: string, beatIndex: number): Promise<boolean> {
  const { data } = await supabase
    .from('video_assets')
    .select('visual_type')
    .eq('video_id', videoId)
    .eq('beat_index', beatIndex)
    .maybeSingle();
  return data?.visual_type === 'uploaded';
}

/**
 * Renders a planned beat as a track of shots cut on its word timings and records the result
 * (a "composite" asset whose source is the local track) so assembly picks it up like any visual.
 */
export async function composeShotBeat(options: ComposeShotBeatOptions): Promise<{ outputPath: string; durationMs: number }> {
  const { supabase, videoId, beat, audioPath, audioDurationMs, outputDir, renderContext, typedRenderers = MOTION_RENDERERS } = options;
  const timings = await loadWordTimings(audioPath);
  const words = timings && timings.text === beat.text ? timings.words : null;

  const composed = await composeBeatTrack({
    beatIndex: beat.index,
    shots: beat.shots ?? [],
    words,
    audioDurationSec: audioDurationMs / 1000,
    outputDir,
    fallbackColor: renderContext.theme.background,
    renderShot: createShotRenderer(
      { ...renderContext, beatIndex: beat.index, downloadDir: path.join(outputDir, 'sources') },
      typedRenderers,
    ),
  });

  const { license, attribution, sources } = summarizeLicenses(composed.shots);
  await upsertVideoAssetProvenance(supabase, {
    video_id: videoId,
    beat_index: beat.index,
    visual_type: 'composite',
    source_url: composed.trackPath,
    license_type: license,
    license_source: sources.length ? `${sources.length} source${sources.length === 1 ? '' : 's'}` : 'generated',
    attribution_text: attribution,
    license_proof_url: sources[0] ?? null,
    candidates_json: null,
  });

  const failed = composed.shots.filter((s) => s.error).length;
  console.log(
    `[Visuals] Beat ${beat.index}: composed ${composed.shots.length} shots (${composed.shots.map((s) => s.renderedType).join(', ')})${failed ? `, ${failed} fell back to plain background` : ''}`,
  );
  return { outputPath: composed.trackPath, durationMs: audioDurationMs };
}
