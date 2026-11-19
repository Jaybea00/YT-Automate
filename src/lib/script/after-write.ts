import type { SupabaseClient } from '@supabase/supabase-js';
import { loadPronunciations } from '@/pipeline/tts/pronunciations';
import { factCheckOrNull } from './fact-check';
import { suggestPronunciationsOrNull } from './pronunciation-hints';
import { adCheckOrLocal } from './ad-check';
import { retentionCheckOrNull } from './retention';
import { chosenPackage } from './packaging-types';
import { prepareVoicePlan } from './voice-plan';
import type { GeneratedScript } from './generate-script';
import type { StylePack } from '@/lib/styles/packs';

/**
 * Checks run on every newly written script, side by side: the independent fact-check, the
 * names the voice may mispronounce, wording likely to limit ads, whether viewers would keep
 * watching, and the voice plan (moods and character voices, applied on approval). Returns the
 * fields to spread into script_json; a failed check never fails the write.
 */
export async function afterWriteChecks(
  supabase: SupabaseClient,
  topic: string,
  script: Pick<GeneratedScript, 'beats' | 'research' | 'title_options'> & Partial<Pick<GeneratedScript, 'packaging'>>,
  style?: string | null,
  pack?: StylePack,
  /** The video, so character voices avoid its own narrator. */
  videoId?: string,
): Promise<Pick<GeneratedScript, 'fact_check' | 'pronunciation_hints' | 'ad_check' | 'retention' | 'voice_plan'>> {
  const [factCheck, hints, adCheck, retention, voicePlan] = await Promise.all([
    factCheckOrNull(supabase, script.beats, script.research),
    loadPronunciations().then((known) =>
      suggestPronunciationsOrNull(supabase, topic, script.beats.map((b) => b.text), known),
    ),
    adCheckOrLocal(supabase, script.beats, script.title_options ?? [], style, pack),
    retentionCheckOrNull(supabase, script.beats, { title: script.title_options?.[0], packaging: chosenPackage(script.packaging), pack }),
    prepareVoicePlan(supabase, videoId, script.beats.map((b, index) => ({ index, text: b.text })), pack?.label).catch((err) => {
      console.warn('[voicePlan] Voice plan failed:', err instanceof Error ? err.message.slice(0, 200) : err);
      return null;
    }),
  ]);
  return {
    ...(factCheck ? { fact_check: factCheck } : {}),
    ...(hints ? { pronunciation_hints: hints } : {}),
    ad_check: adCheck,
    ...(retention ? { retention } : {}),
    ...(voicePlan ? { voice_plan: voicePlan } : {}),
  };
}
