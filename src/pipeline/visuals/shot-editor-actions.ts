import * as path from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '../providers/registry';
import type { LLMProvider, StockProvider } from '../providers/types';
import { gatherCandidates, heuristicRank, visionRank } from './footage-picker';
import { MOTION_RENDERERS, renderTextCard } from './motion-shots';
import { themeForStyle } from './motion/theme';
import type { ComposedShot, ShotAlternative } from './shot-composer';
import { replaceShot, type ComposedBeatRecord } from './shot-editor';
import { candidateFromAlternative, renderCandidateShot, renderFootageShot, toAlternative, type ShotRenderContext } from './shot-renderers';

export type ShotEdit =
  /** Use one of the shot's alternatives, or a search result. */
  | { action: 'swap'; candidate: ShotAlternative }
  /** Pick again, excluding what is there now (graphics re-render, footage re-searches). */
  | { action: 'redo' }
  /** Show the narration as animated type. */
  | { action: 'text' }
  /** The creator's own file (already saved on disk), with its licence and, for a video, an optional start. */
  | { action: 'upload'; filePath: string; mediaType: 'video' | 'image'; license: string; attribution?: string | null; startSec?: number };

async function editorContext(supabase: SupabaseClient, videoId: string, beat: ComposedBeatRecord, needsBrowser: boolean) {
  const { data: video } = await supabase.from('videos').select('style, script_json').eq('id', videoId).maybeSingle();
  const stock = await resolveForStage<StockProvider>('visuals', supabase).catch(() => null);
  const llm = await resolveForStage<LLMProvider>('script', supabase).catch(() => null);
  const browser: Browser | undefined = needsBrowser ? await chromium.launch({ headless: true }) : undefined;
  const ctx: ShotRenderContext = {
    beatIndex: beat.beatIndex,
    downloadDir: path.join(path.dirname(beat.trackPath), 'sources'),
    theme: themeForStyle(video?.style),
    browser,
    stockProvider: stock?.provider,
    stockCtx: stock?.ctx,
    llmProvider: llm?.provider,
    llmCtx: llm?.ctx,
    // The beat's other shots are off limits, so a swap never repeats a neighbour
    usedSources: new Set(beat.shots.map((s) => s.sourceUrl).filter((u): u is string => Boolean(u))),
    motionCounter: { next: beat.beatIndex },
    // A replaced archive shot gets the same texture as the rest of the video (no print beneath:
    // its neighbours are already rendered)
    ...(video?.script_json?.archive_look !== 'off' ? { archiveLook: { count: { next: beat.beatIndex } } } : {}),
  };
  return { ctx, close: async () => browser?.close().catch(() => {}) };
}

const asCandidate = candidateFromAlternative;

/** Applies one edit to one shot of a composed beat. */
export async function editShot(options: {
  supabase: SupabaseClient;
  videoId: string;
  beat: ComposedBeatRecord;
  shotIndex: number;
  edit: ShotEdit;
}): Promise<ComposedShot> {
  const { supabase, videoId, beat, shotIndex, edit } = options;
  const current = beat.shots[shotIndex];
  if (!current) throw new Error(`Beat ${beat.beatIndex} has no shot ${shotIndex}`);
  const plan = current.plan;
  const typed = MOTION_RENDERERS[plan.visual_type];
  const needsBrowser = edit.action === 'text' || Boolean(current.plan.caption) || (edit.action === 'redo' && Boolean(typed));
  const { ctx, close } = await editorContext(supabase, videoId, beat, needsBrowser);
  // What is on screen now is excluded when picking again
  if (current.sourceUrl) ctx.usedSources.add(current.sourceUrl);
  if (edit.action === 'swap') ctx.usedSources.delete(edit.candidate.pageUrl || edit.candidate.downloadUrl);

  try {
    return await replaceShot({
      supabase,
      videoId,
      beat,
      shotIndex,
      render: async (slot, clipPath) => {
        if (edit.action === 'upload') {
          const footagePlan = plan.visual_type === 'archive' || plan.visual_type === 'stock' ? plan : { ...plan, visual_type: 'stock' as const };
          const rendered = await renderCandidateShot(
            footagePlan,
            slot,
            clipPath,
            ctx,
            {
              id: `upload_${path.basename(edit.filePath)}`,
              provider: 'uploaded',
              mediaType: edit.mediaType,
              title: 'Your upload',
              thumbnailUrl: '',
              downloadUrl: edit.filePath,
              license: edit.license,
              attribution: edit.attribution ?? 'Your footage',
            },
            { note: 'uploaded by you', ...(edit.startSec !== undefined ? { startSec: edit.startSec } : {}) },
          );
          return { ...rendered, alternatives: current.alternatives };
        }
        if (edit.action === 'text') {
          return { ...(await renderTextCard(plan, slot, clipPath, ctx, 'set as type by you')), alternatives: current.alternatives };
        }
        if (edit.action === 'swap') {
          const footagePlan = plan.visual_type === 'archive' || plan.visual_type === 'stock' ? plan : { ...plan, visual_type: 'stock' as const };
          const rendered = await renderCandidateShot(footagePlan, slot, clipPath, ctx, asCandidate(edit.candidate), {
            note: `chosen by you${edit.candidate.score !== undefined ? ` (relevance ${edit.candidate.score}/10)` : ''}`,
          });
          const rest = (current.alternatives ?? []).filter((a) => a.downloadUrl !== edit.candidate.downloadUrl);
          return { ...rendered, alternatives: rest };
        }
        // redo: graphics render again (maps and scans search again); footage picks something new
        if (typed) return typed(plan, slot, clipPath, ctx);
        return renderFootageShot(plan, slot, clipPath, ctx);
      },
    });
  } finally {
    await close();
  }
}

/**
 * Footage for a custom search, best first. Every result is returned (with its score when the
 * LLM checked relevance), since the person choosing can judge for themselves.
 */
export async function searchShotFootage(options: {
  supabase: SupabaseClient;
  beat: ComposedBeatRecord;
  shotIndex: number;
  query: string;
}): Promise<ShotAlternative[]> {
  const { supabase, beat, shotIndex, query } = options;
  const current = beat.shots[shotIndex];
  if (!current) throw new Error(`Beat ${beat.beatIndex} has no shot ${shotIndex}`);
  const stock = await resolveForStage<StockProvider>('visuals', supabase).catch(() => null);
  const llm = await resolveForStage<LLMProvider>('script', supabase).catch(() => null);
  const shot = {
    ...current.plan,
    visual_query: query,
    visual_type: current.plan.visual_type === 'archive' ? ('archive' as const) : ('stock' as const),
  };
  const candidates = await gatherCandidates({ shot, stockProvider: stock?.provider, stockCtx: stock?.ctx });
  if (llm?.provider.supportsVision) {
    try {
      return (await visionRank(shot, candidates, llm.provider, llm.ctx)).map((r) => toAlternative(r.candidate, r.score));
    } catch (err) {
      console.warn(`[ShotEditor] Vision ranking unavailable for search: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
  }
  return heuristicRank(shot, candidates).map((r) => toAlternative(r.candidate));
}
