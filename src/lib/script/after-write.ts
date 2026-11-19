import type { SupabaseClient } from '@supabase/supabase-js';
import { loadPronunciations } from '@/pipeline/tts/pronunciations';
import { factCheckOrNull } from './fact-check';
import { suggestPronunciationsOrNull } from './pronunciation-hints';
import { adCheckOrLocal } from './ad-check';
import { retentionCheckOrNull } from './retention';
import { chosenPackage } from './packaging-types';
import type { GeneratedScript } from './generate-script';
import type { StylePack } from '@/lib/styles/packs';

/**
 * Checks run on every newly written script, side by side: the independent fact-check, the
 * names the voice may mispronounce, wording likely to limit ads, and whether viewers would keep
 * watching. Returns the fields to spread into script_json; a failed check never fails the write.
 */
export async function afterWriteChecks(
  supabase: SupabaseClient,
  topic: string,
  script: Pick<GeneratedScript, 'beats' | 'research' | 'title_options'> & Partial<Pick<GeneratedScript, 'packaging'>>,
  style?: string | null,
  pack?: StylePack,
): Promise<Pick<GeneratedScript, 'fact_check' | 'pronunciation_hints' | 'ad_check' | 'retention'>> {
  const [factCheck, hints, adCheck, retention] = await Promise.all([
    factCheckOrNull(supabase, script.beats, script.research),
    loadPronunciations().then((known) =>
      suggestPronunciationsOrNull(supabase, topic, script.beats.map((b) => b.text), known),
    ),
    adCheckOrLocal(supabase, script.beats, script.title_options ?? [], style, pack),
    retentionCheckOrNull(supabase, script.beats, { title: script.title_options?.[0], packaging: chosenPackage(script.packaging), pack }),
  ]);
  return {
    ...(factCheck ? { fact_check: factCheck } : {}),
    ...(hints ? { pronunciation_hints: hints } : {}),
    ad_check: adCheck,
    ...(retention ? { retention } : {}),
  };
}
