import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider } from '@/pipeline/providers/types';
import type { ResearchDossier } from '@/lib/research/types';
import { withStyleDefaults } from '@/lib/styles/packs';
import { generateScript, withWritingModel, type ScriptBeat } from './generate-script';
import { planShots } from './shot-planner';
import { afterWriteChecks } from './after-write';
import type { VideoStyle } from './style-templates';
import type { NativeShortIdea } from './native-shorts-types';

export type { NativeShortIdea, NativeShorts } from './native-shorts-types';

/**
 * Native Shorts: scripts written for the Shorts feed (their own cold hook, one idea, a hard
 * payoff), not cut-downs of the long video. Each one the creator picks becomes a linked mini
 * video that goes through the normal steps and is rendered vertical at Publish.
 */

export const MAX_NATIVE_SHORTS = 3;
/** Narration length for a Short: under a minute with room for the end card. */
export const SHORT_TARGET_MINUTES = 50 / 60;

const IdeasSchema = z.object({
  ideas: z.array(
    z.object({
      title: z.string(),
      hook: z.string(),
      hook_banner: z.string(),
      angle: z.string(),
      promise: z.string(),
      source_beats: z.array(z.number()),
    }),
  ),
});

export function buildShortIdeasPrompt(topic: string, beats: Array<Pick<ScriptBeat, 'index' | 'text'>>): string {
  return `A long YouTube video about "${topic}" is finished. Plan up to ${MAX_NATIVE_SHORTS} native YouTube Shorts drawn from it. Each will get its own new script (about 50 seconds), not a clip of the long video.
A good Short idea is one self-contained moment, fact or twist that grips someone with no context: a shocking turn, a "wait, really?" fact, a mini-mystery with an answer. Use different moments for each.
For each idea:
- title: under 70 characters, intriguing and true
- hook: the exact first line of the Short, said in the first 2 seconds (mid-action or the surprising fact; no intro)
- hook_banner: 2-6 words shown on screen at the top
- angle: shock, mystery, twist, number, or story
- promise: what the viewer finds out by the end
- source_beats: the long video's beat indexes the Short draws its facts from

THE LONG VIDEO (beat index, narration):
${beats.map((b) => `[${b.index}] ${b.text}`).join('\n')}`;
}

export function normalizeShortIdeas(raw: z.infer<typeof IdeasSchema>['ideas'], beatIndexes: number[]): NativeShortIdea[] {
  const valid = new Set(beatIndexes);
  const seen = new Set<string>();
  const ideas: NativeShortIdea[] = [];
  for (const r of raw) {
    const title = r.title.replace(/\s+/g, ' ').replace(/^["“']+|["”']+$/g, '').trim().slice(0, 100);
    const hook = r.hook.trim();
    const sources = [...new Set(r.source_beats.filter((b) => valid.has(b)))].sort((a, b) => a - b);
    if (!title || !hook || sources.length === 0 || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    ideas.push({
      id: `short-${ideas.length + 1}`,
      title,
      hook,
      hook_banner: r.hook_banner.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ') || title,
      angle: r.angle.trim().toLowerCase() || 'story',
      promise: r.promise.trim(),
      source_beats: sources,
    });
  }
  return ideas.slice(0, MAX_NATIVE_SHORTS);
}

export async function draftShortIdeas(
  supabase: SupabaseClient,
  topic: string,
  beats: Array<Pick<ScriptBeat, 'index' | 'text'>>,
): Promise<NativeShortIdea[]> {
  if (beats.length === 0) throw new Error('This video has no script to draw Shorts from');
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  const { data } = await resolved.provider.generateJson(
    {
      system: 'You plan YouTube Shorts that stop the scroll in the first second and pay off before they end.',
      prompt: buildShortIdeasPrompt(topic, beats),
      schema: IdeasSchema,
    },
    withWritingModel(resolved.ctx, resolved.options),
  );
  const ideas = normalizeShortIdeas(data.ideas, beats.map((b) => b.index));
  if (ideas.length === 0) throw new Error('No usable Short ideas came back; try again');
  return ideas;
}

/** The creator's notes for writing one Short: the idea and the long video's lines it draws on. */
export function shortBrief(idea: NativeShortIdea, beats: Array<Pick<ScriptBeat, 'index' | 'text'>>): string {
  const lines = beats.filter((b) => idea.source_beats.includes(b.index)).map((b) => `- ${b.text}`);
  return `Open with this hook, word for word: "${idea.hook}"
Promise to deliver by the end: ${idea.promise}
Angle: ${idea.angle}
Draw only on this material from the full video:
${lines.join('\n')}`;
}

/**
 * Writes the Short's script and creates its mini video, ready for script review. Returns the new
 * video's id. The parent's research comes along, so the Short is fact-linked and checked too.
 */
export async function createNativeShort(
  supabase: SupabaseClient,
  parent: { id: string; style: VideoStyle; research?: ResearchDossier | null; beats: Array<Pick<ScriptBeat, 'index' | 'text'>> },
  idea: NativeShortIdea,
): Promise<string> {
  const { data: row, error } = await supabase
    .from('videos')
    .insert({ topic: idea.title, style: parent.style, target_minutes: SHORT_TARGET_MINUTES, status: 'scripting' })
    .select()
    .single();
  if (error || !row) throw new Error(`Could not create the Short: ${error?.message}`);

  try {
    const written = await generateScript(supabase, {
      topic: idea.title,
      style: parent.style,
      targetMinutes: SHORT_TARGET_MINUTES,
      research: parent.research ?? null,
      brief: shortBrief(idea, parent.beats),
      format: 'short',
    });
    const titled = { ...written, title_options: [idea.title, ...written.title_options.filter((t) => t !== idea.title)] };
    const planned = await planShots(supabase, titled, idea.title, { style: parent.style });
    const checks = await afterWriteChecks(supabase, idea.title, planned, parent.style);
    const scriptJson = {
      ...withStyleDefaults(planned, parent.style),
      ...checks,
      format: 'short' as const,
      short: { parent_video_id: parent.id, hook_banner: idea.hook_banner },
      // Shorts move fast: no extra pause between beats
      beat_pause_seconds: 0,
    };
    const { error: saveError } = await supabase
      .from('videos')
      .update({ script_json: scriptJson, status: 'script_review' })
      .eq('id', row.id);
    if (saveError) throw new Error(saveError.message);
    return row.id as string;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from('videos').update({ status: 'failed', error_message: message }).eq('id', row.id);
    throw new Error(`Writing the Short failed: ${message}`);
  }
}
