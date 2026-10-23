import type { SupabaseClient } from '@supabase/supabase-js';
import { loadCaptionWords } from './caption-sources';
import type { BedCue, SoundCue } from './sound-design';
import {
  bedCues,
  momentCues,
  narrationHash,
  planSoundMoments,
  prepareMomentSounds,
  PLAN_VERSION,
  type SoundMomentPlan,
} from './sound-moments';

/**
 * Assembly's narration sounds and ambience beds: reuses the saved plan while the narration is
 * unchanged (so re-assembling doesn't re-plan or change the sounds), plans and saves it
 * otherwise, then places each available sound on its word and each bed under its stretch.
 */
export async function narrationSoundCues(options: {
  supabase: SupabaseClient;
  videoId: string;
  style?: string | null;
  beats: Array<{ index: number; text: string; audioPath?: string | null; voiceStartMs: number; sceneStartMs: number; sceneEndMs: number }>;
}): Promise<{ cues: SoundCue[]; beds: BedCue[] }> {
  const { supabase, videoId, style } = options;
  const beats = options.beats.filter((b) => b.text.trim());
  if (beats.length === 0) return { cues: [], beds: [] };

  const { data: row } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  const saved = row?.script_json?.sound_moments as SoundMomentPlan | undefined;
  let plan = saved?.textHash === narrationHash(beats) && (saved.version ?? 1) >= PLAN_VERSION ? saved : null;
  if (!plan) {
    plan = await planSoundMoments(supabase, beats, style);
    // Re-read so settings saved during planning aren't lost
    const { data: latest } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
    if (latest?.script_json) {
      await supabase.from('videos').update({ script_json: { ...latest.script_json, sound_moments: plan } }).eq('id', videoId);
    }
    console.log(
      `[SFX] Planned ${plan.moments.length} narration sound(s) and ${plan.beds?.length ?? 0} ambience bed(s): ` +
        [...plan.moments.map((m) => `${m.sound}@"${m.trigger}"`), ...(plan.beds ?? []).map((b) => `${b.sound} beats ${b.start_beat}-${b.end_beat}`)].join(', '),
    );
  }
  const beds = plan.beds ?? [];
  if (plan.moments.length === 0 && beds.length === 0) return { cues: [], beds: [] };

  const files = await prepareMomentSounds([...plan.moments, ...beds]);
  const words = await loadCaptionWords(beats);
  return {
    cues: momentCues(plan.moments, beats, words, Object.fromEntries(beats.map((b) => [b.index, b.voiceStartMs])), files),
    beds: bedCues(beds, Object.fromEntries(beats.map((b) => [b.index, { startMs: b.sceneStartMs, endMs: b.sceneEndMs }])), files),
  };
}
