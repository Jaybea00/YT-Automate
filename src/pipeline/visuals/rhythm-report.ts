import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScriptBeat } from '@/lib/script/generate-script';
import { SPEECH_WORDS_PER_SECOND } from '@/lib/script/script-quality';
import { analyzeRhythm, kindOf, type RhythmReport, type RhythmShot } from '@/lib/script/visual-rhythm';
import { readSidecar } from './shot-editor';
import { stylePack } from '@/lib/styles/packs';

/** A beat with one visual (no shot plan, or the user's upload) counts as one shot of this type. */
function singleVisualType(assetType: string | null | undefined, beat: ScriptBeat): string {
  if (!assetType || ['uploaded', 'stock', 'archive', 'composite'].includes(assetType)) {
    return assetType === 'archive' ? 'archive' : 'stock';
  }
  if (assetType === 'screen_recording') return 'screen_recording';
  return kindOf(assetType) === 'footage' ? assetType : assetType || beat.visual_type;
}

/**
 * The visual rhythm of what was actually rendered, read from each beat's shot sidecar (so it
 * reflects fallbacks and any later edits in the shot editor). Beats without a composed track
 * count as one shot.
 */
export async function computeRenderedRhythm(supabase: SupabaseClient, videoId: string): Promise<RhythmReport | null> {
  const { data: video } = await supabase.from('videos').select('style, script_json').eq('id', videoId).maybeSingle();
  const beats: ScriptBeat[] = Array.isArray(video?.script_json?.beats) ? video!.script_json.beats : [];
  if (beats.length === 0) return null;
  const { data: assets } = await supabase
    .from('video_assets')
    .select('beat_index, visual_type, source_url')
    .eq('video_id', videoId);
  const byBeat = new Map((assets ?? []).map((a: { beat_index: number; visual_type: string | null; source_url: string | null }) => [a.beat_index, a]));
  if (byBeat.size === 0) return null;

  const shots: RhythmShot[] = [];
  for (const beat of beats) {
    const asset = byBeat.get(beat.index);
    const sidecar = asset?.visual_type === 'composite' && asset.source_url ? await readSidecar(asset.source_url).catch(() => null) : null;
    if (sidecar?.shots.length) {
      sidecar.shots.forEach((s, i) => {
        shots.push({
          beat: beat.index,
          shot: i,
          type: s.renderedType,
          seconds: s.durationSec,
          query: kindOf(s.renderedType) === 'footage' ? s.plan?.visual_query : undefined,
          still: s.still,
          fallback: Boolean(s.fallback) || s.renderedType === 'color',
        });
      });
    } else if (asset) {
      shots.push({
        beat: beat.index,
        shot: 0,
        type: singleVisualType(asset.visual_type, beat),
        seconds: beat.text.split(/\s+/).filter(Boolean).length / SPEECH_WORDS_PER_SECOND,
      });
    }
  }
  return shots.length ? analyzeRhythm(shots, 'render', [], stylePack(video?.style)?.maxGraphicsShare) : null;
}

/** Computes the rendered rhythm and saves it beside the plan's in script_json.rhythm. */
export async function saveRenderedRhythm(supabase: SupabaseClient, videoId: string): Promise<RhythmReport | null> {
  const report = await computeRenderedRhythm(supabase, videoId);
  if (!report) return null;
  // Re-read just before writing so edits made while the stage ran aren't lost
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  if (!video?.script_json) return report;
  const scriptJson = { ...video.script_json, rhythm: { ...(video.script_json.rhythm ?? {}), render: report } };
  await supabase.from('videos').update({ script_json: scriptJson }).eq('id', videoId);
  return report;
}
