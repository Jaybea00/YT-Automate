import type { SupabaseClient } from '@supabase/supabase-js';
import { loadPronunciations } from '@/pipeline/tts/pronunciations';
import { factCheckOrNull } from './fact-check';
import { suggestPronunciationsOrNull } from './pronunciation-hints';
import { adCheckOrLocal } from './ad-check';
import type { GeneratedScript } from './generate-script';

/**
 * Checks run on every newly written script, side by side: the independent fact-check, the
 * names the voice may mispronounce, and wording likely to limit ads. Returns the fields to
 * spread into script_json; a failed check never fails the write.
 */
export async function afterWriteChecks(
  supabase: SupabaseClient,
  topic: string,
  script: Pick<GeneratedScript, 'beats' | 'research' | 'title_options'>,
  style?: string | null,
): Promise<Pick<GeneratedScript, 'fact_check' | 'pronunciation_hints' | 'ad_check'>> {
  const [factCheck, hints, adCheck] = await Promise.all([
    factCheckOrNull(supabase, script.beats, script.research),
    loadPronunciations().then((known) =>
      suggestPronunciationsOrNull(supabase, topic, script.beats.map((b) => b.text), known),
    ),
    adCheckOrLocal(supabase, script.beats, script.title_options ?? [], style),
  ]);
  return {
    ...(factCheck ? { fact_check: factCheck } : {}),
    ...(hints ? { pronunciation_hints: hints } : {}),
    ad_check: adCheck,
  };
}
