import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LLMProvider, ProviderCallContext } from '../providers/types';
import { MOODS, MOOD_DESCRIPTIONS, tracksForMood, type Mood, type MusicTrack } from './music-library';
import type { Section } from './pacing';
import { scriptSignature } from './sections';

/**
 * Music that follows the story: each section (chapter) gets a mood, read from what it says, and
 * a track for that mood. Saved as script_json.music_plan so re-renders keep the same music.
 */

export interface SavedMusicPlan {
  moods: Mood[];
  source: 'llm' | 'style';
  signature: string;
}

/** A fallback mood per video style, when the LLM can't be asked. */
const STYLE_MOODS: Record<string, Mood> = {
  true_crime_pov: 'tense',
  cinematic: 'mysterious',
  story_driven: 'mysterious',
  tech: 'curious',
  modernmba: 'curious',
  comparison: 'curious',
  listicle: 'curious',
  eli5: 'curious',
  vox_explainer: 'curious',
};

const MoodSchema = z.object({ sections: z.array(z.object({ index: z.number(), mood: z.enum(MOODS) })) });

export async function planMoodsWithLlm(
  sections: Section[],
  beats: Array<{ text: string }>,
  topic: string,
  llm: LLMProvider,
  ctx: ProviderCallContext,
): Promise<Mood[]> {
  const parts = sections.map((s, i) => {
    const end = sections[i + 1]?.start_beat ?? beats.length;
    const text = beats.slice(s.start_beat, end).map((b) => b.text).join(' ');
    return `Section ${i} "${s.title}": ${text.slice(0, 700)}`;
  });
  const { data } = await llm.generateJson(
    {
      system: 'You are the music supervisor of a documentary YouTube channel.',
      prompt: `Video topic: "${topic}"

Choose the background-music mood for each section, by what the narration is doing emotionally. Moods:
${MOODS.map((m) => `- ${m}: ${MOOD_DESCRIPTIONS[m]}`).join('\n')}

Give the story an arc: change mood where the story turns, and keep it where it continues.

${parts.join('\n\n')}

Return {"sections": [{"index": number, "mood": string}]} with one entry per section.`,
      schema: MoodSchema,
    },
    ctx,
  );
  const byIndex = new Map(data.sections.map((s) => [s.index, s.mood]));
  return sections.map((_, i) => byIndex.get(i) ?? byIndex.get(i - 1) ?? 'mysterious');
}

/** Section moods, planned and saved if missing or stale. Never throws. */
export async function ensureMusicPlan(options: {
  supabase: SupabaseClient;
  videoId: string;
  scriptJson: { beats?: Array<{ text: string }>; music_plan?: SavedMusicPlan } & Record<string, unknown>;
  sections: Section[];
  style?: string | null;
  topic?: string;
  llm?: { provider: LLMProvider; ctx: ProviderCallContext } | null;
}): Promise<Mood[]> {
  const { supabase, videoId, scriptJson, sections, style, topic = '', llm } = options;
  const beats = scriptJson.beats ?? [];
  const signature = `${scriptSignature(beats)}|${sections.map((s) => s.start_beat).join(',')}`;
  const saved = scriptJson.music_plan;
  if (saved?.signature === signature && saved.moods.length === sections.length) return saved.moods;

  let plan: SavedMusicPlan | null = null;
  if (llm && sections.length > 0) {
    const moods = await planMoodsWithLlm(sections, beats, topic, llm.provider, llm.ctx).catch((err) => {
      console.warn(`[Music] Mood planning failed; using the style's mood: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
      return null;
    });
    if (moods) plan = { moods, source: 'llm', signature };
  }
  plan ??= { moods: sections.map(() => STYLE_MOODS[style ?? ''] ?? 'mysterious'), source: 'style', signature };

  const { data: fresh } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  await supabase.from('videos').update({ script_json: { ...(fresh?.script_json ?? scriptJson), music_plan: plan } }).eq('id', videoId);
  console.log(`[Music] Section moods (${plan.source}): ${plan.moods.join(' → ')}`);
  return plan.moods;
}

export interface MusicSegment {
  startMs: number;
  endMs: number;
  track: MusicTrack;
  mood: Mood;
}

/**
 * Tracks for the sections: consecutive sections with the same mood share one segment (the music
 * continues instead of restarting), and neighbouring segments never use the same track. Returns
 * null if no track exists for any mood.
 */
export async function pickMusic(
  sectionTimes: Array<{ startMs: number; endMs: number; mood: Mood }>,
  library: (mood: Mood) => Promise<MusicTrack[]> = (m) => tracksForMood(m),
): Promise<MusicSegment[] | null> {
  // Merge runs of the same mood
  const runs: Array<{ startMs: number; endMs: number; mood: Mood }> = [];
  for (const s of sectionTimes) {
    const last = runs[runs.length - 1];
    if (last && last.mood === s.mood) last.endMs = s.endMs;
    else runs.push({ ...s });
  }

  const used = new Map<string, number>();
  const segments: MusicSegment[] = [];
  for (const run of runs) {
    let tracks = await library(run.mood);
    // A mood with no tracks borrows from a related one rather than leaving silence
    if (tracks.length === 0) tracks = await library(run.mood === 'calm' ? 'mysterious' : 'calm');
    if (tracks.length === 0) continue;
    const previous = segments[segments.length - 1]?.track.path;
    // Least-used track first, never the one just played
    const choice = [...tracks].sort((a, b) => (used.get(a.path) ?? 0) - (used.get(b.path) ?? 0)).find((t) => t.path !== previous) ?? tracks[0];
    used.set(choice.path, (used.get(choice.path) ?? 0) + 1);
    segments.push({ ...run, track: choice });
  }
  return segments.length ? segments : null;
}

/** Credit lines for the description, one block per track that needs one. */
export function musicCredits(segments: MusicSegment[]): string[] {
  return [...new Set(segments.map((s) => s.track.credit).filter((c): c is string => Boolean(c)))];
}
