import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider } from '@/pipeline/providers/types';
import { DELIVERY_MOODS, MOOD_INFO, isDeliveryMood, type DeliveryMood } from './delivery-moods';
import { scriptTextSignature } from './script-quality';

/**
 * The voice plan for a script, made when it's approved (and again on request): a mood for each
 * beat, and the characters whose quoted words get their own voices. Both are saved into the
 * beats' voice settings (script_json.beat_voice), where Vibedit can change them per beat.
 */

export interface CastNarrator {
  id: string;
  name: string;
  voice_id: string;
  provider: string;
}

export interface CharacterLine {
  beat_index: number;
  /** The quoted words exactly as they appear in the beat (without the quote marks). */
  quote: string;
  speaker: string;
}

export interface Casting {
  speakers: Array<{ name: string; narratorId: string }>;
  lines: CharacterLine[];
}

type Beat = { index: number; text: string };

// --------------------------------------------------------------------------
// Moods
// --------------------------------------------------------------------------

const MoodSchema = z.object({ moods: z.array(z.object({ index: z.number(), mood: z.enum(DELIVERY_MOODS) })) });

export function buildMoodPrompt(beats: Beat[], styleLabel?: string): string {
  return `You direct the narrator of a YouTube ${styleLabel ? `${styleLabel} ` : ''}video. Give every beat one delivery mood.

MOODS:
${DELIVERY_MOODS.map((m) => `- ${m}: ${MOOD_INFO[m].use}`).join('\n')}

RULES
- Most beats are "neutral" (at least half). A mood is for moments that clearly call for it.
- "reveal" only for the payoff or the big twist: one to three beats in the whole video.
- Don't change mood every beat; let a mood carry through a passage.
- Match the content, not the topic: a sad fact in a fun video is still "quiet".

BEATS (index, text):
${beats.map((b) => `[${b.index}] ${b.text}`).join('\n')}`;
}

/** Keeps moods for real beats; caps "reveal" at three (the strongest are the model's first). */
export function normalizeMoods(raw: Array<{ index: number; mood: string }>, beats: Beat[]): Map<number, DeliveryMood> {
  const out = new Map<number, DeliveryMood>();
  let reveals = 0;
  for (const r of raw) {
    if (!beats.some((b) => b.index === r.index) || !isDeliveryMood(r.mood) || out.has(r.index)) continue;
    if (r.mood === 'reveal' && ++reveals > 3) continue;
    out.set(r.index, r.mood);
  }
  return out;
}

export async function suggestMoods(supabase: SupabaseClient, beats: Beat[], styleLabel?: string): Promise<Map<number, DeliveryMood>> {
  const { provider, ctx } = await resolveForStage<LLMProvider>('script', supabase);
  const { data } = await provider.generateJson({ prompt: buildMoodPrompt(beats, styleLabel), schema: MoodSchema, maxTokens: 8000 }, ctx);
  return normalizeMoods(data.moods, beats);
}

// --------------------------------------------------------------------------
// Characters
// --------------------------------------------------------------------------

const CastSchema = z.object({
  speakers: z.array(z.object({ name: z.string(), narrator_id: z.string(), why: z.string() })),
  lines: z.array(z.object({ beat_index: z.number(), quote: z.string(), speaker: z.string() })),
});

export function buildCastPrompt(beats: Beat[], narrators: CastNarrator[], mainVoice?: string): string {
  return `Find the words in this narration that are quoted from a specific person (a letter, a witness, a historical figure, someone in the story) and cast a voice for each person.

RULES
- Only direct quotes of a person's own words that are written in quote marks. Not paraphrase, not sayings, not titles, not single words in quotes.
- "quote": the quoted words copied EXACTLY as they appear in the beat, without the quote marks and without the attribution ("he wrote").
- One voice per person, and every quote of that person uses it. Skip people quoted only once in a few words (under 6 words).
- Pick each person's voice from the NARRATORS list by id. The voice must speak the narration's language: an English script needs an English voice even for a foreign person (Kokoro ids: the first letter is the language/accent, a = American English, b = British English, e = Spanish, f = French, h = Hindi, i = Italian, j = Japanese, p = Portuguese, z = Chinese; the second letter f = female, m = male, so "af_" = American English female, "bm_" = British English male). Match gender and age where the names show it. Prefer voices from the same provider as the main narrator, and never the main narrator itself${mainVoice ? ` (${mainVoice})` : ''}.
- Return empty lists when nobody is quoted.

NARRATORS (id | name | provider | voice):
${narrators.map((n) => `${n.id} | ${n.name} | ${n.provider} | ${n.voice_id}`).join('\n')}

BEATS (index, text):
${beats.map((b) => `[${b.index}] ${b.text}`).join('\n')}`;
}

/** Strips matching quote marks from both ends ("…" '…' “…” ‘…’). */
const unquote = (s: string) => s.trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();

/** Curly and straight quote marks treated alike (one character for one, so positions match). */
const flatQuotes = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** The quote as it's written in the beat (whatever its apostrophes), or null when it isn't there. */
export function findInBeat(beatText: string, quote: string): string | null {
  const at = flatQuotes(beatText).indexOf(flatQuotes(quote));
  return at >= 0 ? beatText.slice(at, at + quote.length) : null;
}

/**
 * Keeps only casting that can be voiced: quotes found word for word in their beat, speakers with
 * a real narrator (not the main one), at most one quote per beat per speaker.
 */
export function normalizeCasting(raw: z.infer<typeof CastSchema>, beats: Beat[], narrators: CastNarrator[], mainNarratorId?: string | null): Casting {
  const ids = new Set(narrators.map((n) => n.id));
  const speakers = new Map<string, string>();
  for (const s of raw.speakers) {
    const name = s.name.trim();
    if (name && ids.has(s.narrator_id) && s.narrator_id !== mainNarratorId && !speakers.has(name.toLowerCase())) speakers.set(name.toLowerCase(), s.narrator_id);
  }
  const lines: CharacterLine[] = [];
  const seen = new Set<string>();
  for (const l of raw.lines) {
    const beat = beats.find((b) => b.index === l.beat_index);
    const speaker = l.speaker.trim();
    const quote = beat ? findInBeat(beat.text, unquote(l.quote)) : null;
    if (!beat || !quote || quote.split(/\s+/).length < 3 || !speakers.has(speaker.toLowerCase())) continue;
    const key = `${beat.index}|${speaker.toLowerCase()}|${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({ beat_index: beat.index, quote, speaker });
  }
  const used = new Set(lines.map((l) => l.speaker.toLowerCase()));
  return {
    speakers: raw.speakers.filter((s) => used.has(s.name.trim().toLowerCase()) && speakers.get(s.name.trim().toLowerCase()) === s.narrator_id).map((s) => ({ name: s.name.trim(), narratorId: s.narrator_id })),
    lines,
  };
}

/** Active narrators to cast from, and the video's main narrator (when the video is known). */
export async function castingNarrators(supabase: SupabaseClient, videoId?: string): Promise<{ narrators: CastNarrator[]; mainId: string | null; mainVoice?: string }> {
  const [{ data: video }, { data: rows }] = await Promise.all([
    videoId ? supabase.from('videos').select('narrator_id').eq('id', videoId).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from('narrators').select('id, name, voice_id, provider_slug, yt_provider_configs ( provider, is_active )'),
  ]);
  const narrators = (rows ?? [])
    .filter((n) => (n as { yt_provider_configs?: { is_active?: boolean } | null }).yt_provider_configs?.is_active !== false)
    .map((n) => ({ id: n.id as string, name: (n.name as string) ?? '', voice_id: (n.voice_id as string) ?? '', provider: (n.provider_slug as string) || ((n as { yt_provider_configs?: { provider?: string } | null }).yt_provider_configs?.provider ?? '') }));
  const mainId = (video?.narrator_id as string | null) ?? null;
  const main = narrators.find((n) => n.id === mainId);
  return { narrators, mainId, mainVoice: main ? `${main.name}, ${main.provider}` : undefined };
}

/** Whether any beat quotes someone at all (nothing in quote marks: nobody to cast). */
export const hasQuotes = (beats: Beat[]) => beats.some((b) => /["“][^"”]{12,}["”]/.test(b.text));

/**
 * Finds quoted people and casts their voices. `fast` uses the light helper model with no retry
 * (seconds, may miss quotes); otherwise the writing model (better, can take a minute).
 */
export async function castCharacters(supabase: SupabaseClient, videoId: string | undefined, beats: Beat[], opts: { fast?: boolean } = {}): Promise<Casting> {
  if (!hasQuotes(beats)) return { speakers: [], lines: [] };
  const { narrators, mainId, mainVoice } = await castingNarrators(supabase, videoId);
  if (narrators.length < 2) return { speakers: [], lines: [] };
  // The writing model: in testing the light helper model missed obvious quotes about half the time
  const { provider, ctx, options } = await resolveForStage<LLMProvider>('script', supabase);
  const writingModel = !opts.fast && typeof options.writingModel === 'string' && options.writingModel.trim() ? options.writingModel.trim() : ctx.model;
  const ask = async () => {
    const { data } = await provider.generateJson({ prompt: buildCastPrompt(beats, narrators, mainVoice), schema: CastSchema, maxTokens: 8000 }, { ...ctx, model: writingModel });
    return normalizeCasting(data, beats, narrators, mainId);
  };
  const first = await ask();
  // Long quotes and nobody found: one more try before giving up
  const longQuote = beats.some((b) => /["“][^"”]{30,}["”]/.test(b.text));
  return first.lines.length || !longQuote || opts.fast ? first : ask();
}

/**
 * Plans moods and/or characters for a video's script. Each part fails on its own (with a
 * warning) so one failing never loses the other.
 */
export async function planVoice(
  supabase: SupabaseClient,
  videoId: string | undefined,
  beats: Beat[],
  opts: { moods: boolean; characters: boolean; styleLabel?: string; fast?: boolean },
): Promise<{ moods?: Map<number, DeliveryMood>; casting?: Casting; warnings: string[] }> {
  const warnings: string[] = [];
  const [moods, casting] = await Promise.all([
    opts.moods
      ? suggestMoods(supabase, beats, opts.styleLabel).catch((err) => {
          warnings.push(`Moods could not be suggested: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
          return undefined;
        })
      : undefined,
    opts.characters
      ? castCharacters(supabase, videoId, beats, { fast: opts.fast }).catch((err) => {
          warnings.push(`Characters could not be cast: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
          return undefined;
        })
      : undefined,
  ]);
  return { moods, casting, warnings };
}

/** A plan made in the background when the script was written, for approval to apply at once. */
export interface SavedVoicePlan {
  /** The script it was made for (scriptTextSignature); an edited script no longer matches. */
  basedOn: string;
  moods: Array<[number, DeliveryMood]>;
  casting: Casting;
  madeAt: string;
}

/** Plans the voice after writing (the slow, careful casting); null when both parts failed. */
export async function prepareVoicePlan(supabase: SupabaseClient, videoId: string | undefined, beats: Beat[], styleLabel?: string): Promise<SavedVoicePlan | null> {
  const plan = await planVoice(supabase, videoId, beats, { moods: true, characters: true, styleLabel });
  for (const w of plan.warnings) console.warn(`[voicePlan] ${w}`);
  if (!plan.moods && !plan.casting) return null;
  return { basedOn: scriptTextSignature(beats), moods: [...(plan.moods ?? new Map())], casting: plan.casting ?? { speakers: [], lines: [] }, madeAt: new Date().toISOString() };
}

/** Saved character lines moved to wherever their quote now is; lines whose quote is gone are dropped. */
export function revalidateCasting(casting: Casting, beats: Beat[]): Casting {
  const lines = casting.lines.flatMap((l) => {
    const beat = beats.find((b) => b.index === l.beat_index && findInBeat(b.text, l.quote)) ?? beats.find((b) => findInBeat(b.text, l.quote));
    const quote = beat ? findInBeat(beat.text, l.quote) : null;
    return beat && quote ? [{ ...l, beat_index: beat.index, quote }] : [];
  });
  const used = new Set(lines.map((l) => l.speaker.toLowerCase()));
  return { speakers: casting.speakers.filter((s) => used.has(s.name.toLowerCase())), lines };
}

/**
 * The plan to apply when the script is approved: the saved one as it is when the script hasn't
 * changed since; otherwise fresh moods (fast) and the saved characters moved to their quotes. A
 * script with no saved plan (written before plans existed) gets a quick plan.
 */
export async function planForApproval(
  supabase: SupabaseClient,
  videoId: string,
  beats: Beat[],
  saved: SavedVoicePlan | null | undefined,
  styleLabel?: string,
): Promise<{ moods?: Map<number, DeliveryMood>; casting?: Casting; warnings: string[]; source: 'saved' | 'updated' | 'quick' }> {
  if (saved && saved.basedOn === scriptTextSignature(beats)) return { moods: new Map(saved.moods), casting: saved.casting, warnings: [], source: 'saved' };
  if (saved) {
    const plan = await planVoice(supabase, videoId, beats, { moods: true, characters: false, styleLabel, fast: true });
    return { ...plan, casting: revalidateCasting(saved.casting, beats), source: 'updated' };
  }
  return { ...(await planVoice(supabase, videoId, beats, { moods: true, characters: true, styleLabel, fast: true })), source: 'quick' };
}

/** A short description of a plan, for the page. */
export function describePlan(moods: Map<number, DeliveryMood> | undefined, casting: Casting | undefined): string {
  const parts: string[] = [];
  if (moods) {
    const counts = new Map<DeliveryMood, number>();
    for (const m of moods.values()) if (m !== 'neutral') counts.set(m, (counts.get(m) ?? 0) + 1);
    parts.push(counts.size ? [...counts].map(([m, n]) => `${n} ${MOOD_INFO[m].label.toLowerCase()}`).join(', ') : 'all neutral');
  }
  if (casting) parts.push(casting.speakers.length ? `${casting.speakers.length} character${casting.speakers.length === 1 ? '' : 's'} (${casting.speakers.map((s) => s.name).join(', ')}) in ${casting.lines.length} line${casting.lines.length === 1 ? '' : 's'}` : 'no quoted characters');
  return parts.join(' · ');
}

// --------------------------------------------------------------------------
// Into the beats' voice settings
// --------------------------------------------------------------------------

type BeatVoiceRaw = Record<string, unknown>;

/**
 * The beats' voice settings with a new plan applied: moods replace the old ones (neutral removes
 * one), and when casting is given, every beat's character parts are replaced by it. Recordings,
 * speeds, narrators and takes are kept.
 */
export function applyVoicePlan(
  beatVoice: Record<string, BeatVoiceRaw> | null | undefined,
  plan: { moods?: Map<number, DeliveryMood>; casting?: Casting },
): Record<string, BeatVoiceRaw> {
  const out: Record<string, BeatVoiceRaw> = {};
  for (const [k, v] of Object.entries(beatVoice ?? {})) out[k] = { ...v };
  const touch = (i: number) => (out[String(i)] ??= {});
  if (plan.moods) {
    for (const v of Object.values(out)) delete v.mood;
    for (const [i, mood] of plan.moods) if (mood !== 'neutral') touch(i).mood = mood;
  }
  if (plan.casting) {
    for (const v of Object.values(out)) delete v.parts;
    const narratorOf = new Map(plan.casting.speakers.map((s) => [s.name.toLowerCase(), s.narratorId]));
    for (const l of plan.casting.lines) {
      const narratorId = narratorOf.get(l.speaker.toLowerCase());
      if (!narratorId) continue;
      const v = touch(l.beat_index);
      v.parts = [...((v.parts as unknown[]) ?? []), { text: l.quote, narratorId, speaker: l.speaker }];
    }
  }
  for (const [k, v] of Object.entries(out)) if (!Object.keys(v).length) delete out[k];
  return out;
}

const planOf = (v: BeatVoiceRaw | undefined) => JSON.stringify({ mood: v?.mood ?? null, parts: v?.parts ?? null });

/** The beats whose mood or characters differ between two sets of voice settings. */
export function changedBeats(before: Record<string, BeatVoiceRaw>, after: Record<string, BeatVoiceRaw>, beatCount: number): number[] {
  return Array.from({ length: beatCount }, (_, i) => i).filter((i) => planOf(before[i]) !== planOf(after[i]));
}
