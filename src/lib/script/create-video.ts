import type { SupabaseClient } from '@supabase/supabase-js';
import { researchTopic } from '@/lib/research/research';
import { keptStyle, packForVideo } from '@/lib/styles/compose';
import { narrationPaceFactor, withStyleDefaults, type StylePack } from '@/lib/styles/packs';
import { afterWriteChecks } from './after-write';
import { generateScript, type GeneratedScript } from './generate-script';
import { generateOutline, trimBrief } from './outline';
import { chosenPackage, generatePackagingOrNull } from './packaging';
import { parseRawTextWithAi } from './parser';
import { estimateSpeechSeconds } from './script-quality';
import { planShots } from './shot-planner';
import type { VideoStyle } from './style-templates';
import type { CreationStep } from './creation-steps';

export { CREATION_STEP_LABELS, type CreationStep } from './creation-steps';

/**
 * Writing a new video's script in the background (see creation-queue.ts). The new-video page
 * saves the request on the video (script_json.creation) and moves straight to the review page,
 * which shows the step under way; a failed or lost run can be retried from the same request.
 */

export interface CreationRequest {
  /** 'ai': research and write from a topic (and brief). 'raw_ai': segment the creator's own text. */
  mode: 'ai' | 'raw_ai';
  topic: string;
  targetMinutes: number;
  brief?: string | null;
  rawText?: string | null;
}

export interface CreationState {
  request: CreationRequest;
  step: CreationStep;
  queuedAt: string;
  startedAt?: string;
  /** Updated at every step. */
  heartbeatAt: string;
  attempts: number;
  error?: string | null;
}

export function isCreationRequest(value: unknown): value is CreationRequest {
  const r = value as CreationRequest | null;
  return Boolean(r) && (r!.mode === 'ai' || r!.mode === 'raw_ai') && typeof r!.topic === 'string' && Number(r!.targetMinutes) > 0;
}

export function newCreationState(request: CreationRequest, attempts = 1): CreationState {
  const now = new Date().toISOString();
  return { request, step: 'waiting', queuedAt: now, heartbeatAt: now, attempts };
}

/** A pasted script's spoken length in minutes, estimated as the review page's runtime meter does. */
export function scriptMinutes(beats: GeneratedScript['beats'], style: string, pack?: StylePack): number {
  const pace = narrationPaceFactor(style, pack);
  const seconds = beats.reduce((n, b) => n + estimateSpeechSeconds(b.text) / pace, 0) + beats.length * 0.5;
  return Math.max(0.5, Math.round((seconds / 60) * 10) / 10);
}

interface VideoRow {
  id: string;
  style: string;
  status: string;
  script_json: (Record<string, unknown> & { creation?: CreationState }) | null;
}

/**
 * Writes the script for a video waiting in 'scripting', from the request saved on it. Updates the
 * video as it goes; on failure the video is marked failed with the request kept for a retry.
 */
export async function runCreation(supabase: SupabaseClient, videoId: string): Promise<void> {
  const { data, error } = await supabase.from('videos').select('id, style, status, script_json').eq('id', videoId).maybeSingle();
  const video = data as VideoRow | null;
  if (error || !video) throw new Error(`Video ${videoId} not found: ${error?.message ?? ''}`);
  const creation = video.script_json?.creation;
  if (video.status !== 'scripting' || !creation || !isCreationRequest(creation.request)) return;

  const request = creation.request;
  const style = video.style as VideoStyle;
  // A video made from a format and niche saved its composed pack; older requests use the style's
  const composed = video.script_json?.style_pack ? packForVideo(video) : undefined;
  const styleFields = keptStyle(video.script_json);
  const topic = request.topic.trim();
  let current: CreationState = { ...creation, startedAt: new Date().toISOString(), error: null };

  const step = async (next: CreationStep) => {
    current = { ...current, step: next, heartbeatAt: new Date().toISOString() };
    await supabase.from('videos').update({ script_json: { ...styleFields, creation: current } }).eq('id', videoId);
  };
  /** The finished script_json: the style's starting settings and the saved style come along. */
  const finished = (script: object) => ({ ...styleFields, ...withStyleDefaults(script, style, composed) });
  const save = async (updates: Record<string, unknown>) => {
    const { error: saveError } = await supabase.from('videos').update(updates).eq('id', videoId);
    if (saveError) throw new Error(`Failed to save the script: ${saveError.message}`);
  };

  try {
    if (request.mode === 'raw_ai') {
      await step('segmenting');
      const segmented = await parseRawTextWithAi(supabase, request.rawText ?? '', { topic, style, pack: composed });
      await step('shots');
      const planned = await planShots(supabase, segmented, topic, { style, pack: composed });
      await save({
        script_json: finished(planned),
        status: 'script_review',
        title: planned.title_options[0] || topic,
        // The creator's own words set the length, not the form's default
        target_minutes: scriptMinutes(planned.beats, style, composed),
        error_message: null,
      });
      return;
    }

    const brief = trimBrief(request.brief ?? undefined);
    const targetMinutes = Number(request.targetMinutes);
    await step('research');
    const research = await researchTopic(supabase, topic, brief || null);
    await step('packaging');
    // Packaging first: the title and thumbnail promise the script will be written to deliver
    const packaging = await generatePackagingOrNull(supabase, { topic, style, pack: composed, targetMinutes, research, brief: brief || null });

    // Brief mode: stop at an outline for the creator to approve; the script is written after
    if (brief) {
      await step('outline');
      try {
        const drafted = await generateOutline(supabase, { topic, style, pack: composed, targetMinutes, brief, research });
        await save({
          script_json: finished({
            title_options: [],
            beats: [],
            brief,
            outline: drafted.outline,
            brief_extras: drafted.extras,
            ...(drafted.research ? { research: drafted.research } : {}),
            ...(packaging ? { packaging } : {}),
          }),
          status: 'script_review',
          error_message: null,
        });
        return;
      } catch (outlineError) {
        // The brief still guides the script; only the approval step is skipped
        console.warn('[creation] Outline failed; writing the script straight from the brief:', outlineError);
      }
    }

    await step('writing');
    const written = await generateScript(supabase, {
      topic,
      style,
      pack: composed,
      targetMinutes,
      research,
      brief: brief || null,
      packaging: chosenPackage(packaging),
    });
    await step('shots');
    const planned = await planShots(supabase, written, topic, { style, pack: composed });
    await step('checks');
    const checks = await afterWriteChecks(supabase, topic, planned, style, composed);
    await save({
      script_json: finished({ ...planned, ...(brief ? { brief } : {}), ...(packaging ? { packaging } : {}), ...checks }),
      status: 'script_review',
      error_message: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from('videos')
      .update({
        status: 'failed',
        error_message: `Script generation failed: ${message}`,
        // The request stays, so the review page can try again
        script_json: { ...styleFields, creation: { ...current, error: message, heartbeatAt: new Date().toISOString() } },
      })
      .eq('id', videoId);
  }
}
