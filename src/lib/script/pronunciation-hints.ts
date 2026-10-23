import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider } from '@/pipeline/providers/types';
import type { Pronunciation } from '@/pipeline/tts/speakable';
import type { PronunciationHint, PronunciationHints } from './pronunciation-hints-types';

export type { PronunciationHint, PronunciationHints } from './pronunciation-hints-types';

/**
 * Finds names in a script that an English voice is likely to say wrongly (Čabrinović, Gatun,
 * Ibrahimović) and suggests respellings. The creator reviews them on the script page; the
 * ticked ones join the channel's pronunciation list when the script is approved, before voicing.
 */

const MAX_CANDIDATES = 150;
const MAX_HINTS = 40;

const HintsSchema = z.object({
  hints: z.array(z.object({ term: z.string(), say: z.string(), note: z.string().optional() })),
});

/** Words worth asking about: capitalised words and anything with letters outside plain English. */
export function pronunciationCandidates(texts: string[], known: Pronunciation[] = []): string[] {
  const knownTerms = new Set(known.map((p) => p.term.toLowerCase()));
  const seen = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.matchAll(/[\p{L}][\p{L}\p{M}'’-]*[\p{L}\p{M}]/gu)) {
      const word = match[0].replace(/['’]s$/u, '');
      const capitalised = /^\p{Lu}/u.test(word) && word.length >= 3;
      // Words hold only letters, apostrophes and hyphens, so anything else is a non-English letter
      const foreign = /[^a-z'’-]/i.test(word);
      if (!capitalised && !foreign) continue;
      const key = word.toLowerCase();
      if (knownTerms.has(key) || seen.has(key)) continue;
      seen.set(key, word);
    }
  }
  return [...seen.values()].slice(0, MAX_CANDIDATES);
}

export function buildPronunciationPrompt(topic: string, candidates: string[]): string {
  return `An English text-to-speech voice will narrate a video about "${topic}".
From the words below, pick the ones it is likely to mispronounce: foreign names of people and places, unusual spellings, words whose English reading misleads. Skip ordinary English words and well-known names an English voice already says correctly (London, Napoleon, Manchester, Liverpool).
For each, give a respelling in simple English syllables separated by hyphens, with the stressed syllable in CAPITALS, e.g. "Creditanstalt" -> "kreh-dit-AHN-shtalt", "Čabrinović" -> "chah-BREE-noh-vich". Use the pronunciation English-language documentaries and commentators use (for a footballer, how English commentators say the name). Add a short note on what it is (e.g. "Serbian surname").
Use each term exactly as written below. Return {"hints": []} when none need help.

WORDS:
${candidates.join(', ')}`;
}

/** Keeps hints for words that are really in the script, once each, with a respelling that differs. */
export function normalizeHints(raw: z.infer<typeof HintsSchema>['hints'], candidates: string[]): PronunciationHint[] {
  const byKey = new Map(candidates.map((c) => [c.toLowerCase(), c]));
  const seen = new Set<string>();
  const hints: PronunciationHint[] = [];
  for (const h of raw) {
    const term = byKey.get(h.term.trim().toLowerCase());
    const say = h.say.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!term || !say || say.toLowerCase() === term.toLowerCase() || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const note = h.note?.trim();
    hints.push({ term, say, ...(note ? { note } : {}) });
  }
  return hints.slice(0, MAX_HINTS);
}

export async function suggestPronunciations(
  supabase: SupabaseClient,
  topic: string,
  texts: string[],
  known: Pronunciation[],
): Promise<PronunciationHints> {
  const candidates = pronunciationCandidates(texts, known);
  const checkedAt = new Date().toISOString();
  if (candidates.length === 0) return { checkedAt, hints: [] };
  const { provider, ctx } = await resolveForStage<LLMProvider>('script', supabase);
  const { data } = await provider.generateJson(
    {
      system: 'You are a pronunciation coach for documentary narrators.',
      prompt: buildPronunciationPrompt(topic, candidates),
      schema: HintsSchema,
    },
    ctx,
  );
  return { checkedAt, hints: normalizeHints(data.hints, candidates) };
}

/** The automatic run after a script is written: never fails the write. */
export async function suggestPronunciationsOrNull(
  supabase: SupabaseClient,
  topic: string,
  texts: string[],
  known: Pronunciation[],
): Promise<PronunciationHints | null> {
  try {
    const result = await suggestPronunciations(supabase, topic, texts, known);
    console.log(`[pronunciation] ${result.hints.length} name(s) may need help: ${result.hints.map((h) => h.term).join(', ')}`);
    return result;
  } catch (err) {
    console.warn('[pronunciation] Name check failed; skipping:', err instanceof Error ? err.message.slice(0, 200) : err);
    return null;
  }
}

/**
 * The channel list with the ticked hints added (existing entries win), and the hints marked
 * as added. Used on approval and by "Add now".
 */
export function mergeHintsIntoList(
  list: Pronunciation[],
  hints: PronunciationHint[],
): { list: Pronunciation[]; hints: PronunciationHint[]; added: number } {
  const known = new Set(list.map((p) => p.term.toLowerCase()));
  const additions: Pronunciation[] = [];
  const marked = hints.map((h) => {
    if (h.skip || h.added) return h;
    if (!known.has(h.term.toLowerCase()) && h.say.trim()) {
      additions.push({ term: h.term, say: h.say.trim() });
      known.add(h.term.toLowerCase());
    }
    return { ...h, added: true };
  });
  return { list: [...list, ...additions], hints: marked, added: additions.length };
}
