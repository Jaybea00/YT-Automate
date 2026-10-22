import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { Browser } from 'playwright';
import type { ShotPlan, ShotType } from '@/lib/script/generate-script';
import { toStockQuery } from '@/lib/script/script-quality';
import type { LLMProvider, ProviderCallContext, StockProvider } from '../providers/types';
import { probeClipDurationSec } from '../assembly/assemble-beat';
import { normalizeLicenseType } from '../utils/media-upload';
import { STILL_MOTIONS, makeFootageClip } from './clips';
import { applyCaption, renderTextCard } from './motion-shots';
import { downloadCandidateAsset } from './media-aggregator';
import { pickFootage } from './footage-picker';
import { pickVideoSegment } from './segment-picker';
import type { MotionTheme } from './motion/theme';
import { FPS, renderMotionClip } from './motion/frame-renderer';
import { annotatedPhotoTemplate, locateTarget, photoForRender } from './annotated-photo';
import { ensureArchiveTextures, treatmentFor, type ArchiveTreatment } from './archive-look';
import type { RenderedShot, ShotAlternative, ShotRenderer, ShotSlot } from './shot-composer';
import type { MediaCandidate } from './types';

export interface ShotRenderContext {
  beatIndex: number;
  /** Where downloaded sources are cached for this job. */
  downloadDir: string;
  theme: MotionTheme;
  browser?: Browser;
  stockProvider?: StockProvider;
  stockCtx?: ProviderCallContext;
  llmProvider?: LLMProvider;
  llmCtx?: ProviderCallContext;
  /** Sources already used in this video, so no clip appears twice. Shared across beats. */
  usedSources: Set<string>;
  /** Rotates camera moves across stills so neighbouring shots don't move the same way. */
  motionCounter: { next: number };
  /**
   * Archive texture (archive-look.ts), shared across beats; absent when switched off. Counts
   * archive shots (for alternating tilts and occasional light leaks) and remembers the last
   * archive photo, which lies under the next print.
   */
  archiveLook?: { count: { next: number }; lastStill?: { path: string; key: string } };
}

/** Archives whose footage is genuinely old; NASA's library is mostly modern. */
const HISTORICAL_PROVIDERS = new Set(['wikimedia', 'archive_org']);

/** A specialised renderer for one shot type (motion graphics, maps, newspapers...). */
export type TypedShotRenderer = (shot: ShotPlan, slot: ShotSlot, clipPath: string, ctx: ShotRenderContext) => Promise<RenderedShot>;

const MAX_DOWNLOAD_ATTEMPTS = 3;

const sourceKey = (c: MediaCandidate) => String(c.pageUrl || c.downloadUrl || c.id);

/**
 * Where to start in a source video: long films (archive reels) start a fifth of the way in,
 * past title cards and leader; short stock clips start at the beginning.
 */
export function chooseVideoStart(sourceSec: number, shotSec: number): number {
  if (sourceSec <= shotSec * 3) return 0;
  const start = Math.max(0, Math.min(sourceSec * 0.2, sourceSec - shotSec - 0.5));
  return Math.round(start * 1000) / 1000;
}

/** No candidate clearly showed the shot; showing something unrelated would be worse than none. */
export class NoRelevantFootageError extends Error {}

/**
 * Finds footage for a shot: searches with several phrasings of the shot's query, keeps only
 * candidates the LLM can see actually show it (when vision is available), skips sources already
 * used in the video, tries the next candidate when a download fails, and renders the chosen photo
 * or video to an exact-length clip, starting long films where the subject appears.
 */
export async function renderFootageShot(
  shot: ShotPlan,
  slot: ShotSlot,
  clipPath: string,
  ctx: ShotRenderContext,
  options: { query?: string; preferArchive?: boolean; note?: string } = {},
): Promise<RenderedShot> {
  const query = options.query ?? shot.visual_query;
  const preferArchive = options.preferArchive ?? shot.visual_type === 'archive';
  const searchShot: ShotPlan = { ...shot, visual_query: query, visual_type: preferArchive ? 'archive' : 'stock' };
  const { ranked, checked } = await pickFootage({
    shot: searchShot,
    stockProvider: ctx.stockProvider,
    stockCtx: ctx.stockCtx,
    exclude: ctx.usedSources,
    llmProvider: ctx.llmProvider,
    llmCtx: ctx.llmCtx,
  });
  if (ranked.length === 0) {
    throw new NoRelevantFootageError(
      checked ? `No candidate clearly shows "${query}"` : `No footage found for "${query}"`,
    );
  }

  const alternatives = (chosen: MediaCandidate) =>
    ranked
      .filter((r) => r.candidate !== chosen)
      .slice(0, MAX_ALTERNATIVES)
      .map((r) => toAlternative(r.candidate, checked ? r.score : undefined));

  let lastError: unknown = new Error(`No footage found for "${query}"`);
  for (const { candidate, score } of ranked.slice(0, MAX_DOWNLOAD_ATTEMPTS)) {
    try {
      const rendered = await renderCandidateShot(searchShot, slot, clipPath, ctx, candidate, {
        note: [options.note, checked ? `relevance ${score.toFixed(1)}/10` : 'unchecked relevance'].filter(Boolean).join('; '),
        captionShot: shot,
        score: checked ? score : undefined,
      });
      return { ...rendered, alternatives: alternatives(candidate) };
    } catch (err) {
      lastError = err;
      console.warn(`[ShotRenderer] Beat ${ctx.beatIndex}: candidate ${candidate.provider} failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  }
  throw lastError;
}

const MAX_ALTERNATIVES = 6;

export function toAlternative(c: MediaCandidate, score?: number): ShotAlternative {
  return {
    id: String(c.id),
    provider: c.provider,
    mediaType: c.mediaType,
    title: c.title,
    thumbnailUrl: c.thumbnailUrl,
    downloadUrl: c.downloadUrl,
    pageUrl: c.pageUrl,
    license: c.license,
    attribution: c.attribution,
    score: score === undefined ? undefined : Math.round(score * 10) / 10,
  };
}

export const candidateFromAlternative = (a: ShotAlternative): MediaCandidate => ({
  id: a.id,
  provider: a.provider as MediaCandidate['provider'],
  mediaType: a.mediaType,
  title: a.title,
  thumbnailUrl: a.thumbnailUrl,
  downloadUrl: a.downloadUrl,
  pageUrl: a.pageUrl,
  license: a.license,
  attribution: a.attribution,
});

/**
 * Renders one specific candidate as the shot: downloads it (cached per source), starts long films
 * where the subject appears, applies the camera move or video hold, and adds the shot's caption.
 */
export async function renderCandidateShot(
  shot: ShotPlan,
  slot: ShotSlot,
  clipPath: string,
  ctx: ShotRenderContext,
  candidate: MediaCandidate,
  options: { note?: string; captionShot?: ShotPlan; score?: number } = {},
): Promise<RenderedShot> {
  const isVideo = candidate.mediaType === 'video';
  const ext = isVideo ? '.mp4' : path.extname(new URL(candidate.downloadUrl).pathname).toLowerCase().replace(/[^.a-z]/g, '') || '.jpg';
  const hash = crypto.createHash('sha1').update(sourceKey(candidate)).digest('hex').slice(0, 16);
  const sourcePath = path.join(ctx.downloadDir, `${candidate.provider}_${hash}${ext}`);
  await downloadCandidateAsset(candidate, sourcePath, ctx.stockCtx, ctx.stockProvider);
  const fromArchive = ['archive_org', 'wikimedia', 'nasa'].includes(candidate.provider);
  const source = {
    sourceUrl: candidate.pageUrl || candidate.downloadUrl,
    license: normalizeLicenseType(candidate.license),
    licenseSource: candidate.provider,
    attribution: candidate.attribution ?? null,
    chosen: toAlternative(candidate, options.score),
  };

  // A photo with an annotation: circle and label its subject when the vision model can find it
  const annotation = (options.captionShot ?? shot).annotation;
  if (!isVideo && annotation && ctx.llmProvider?.supportsVision && ctx.llmCtx) {
    try {
      const box = await locateTarget(sourcePath, annotation, ctx.llmProvider, ctx.llmCtx, candidate.title);
      if (box) {
        await renderMotionClip({
          html: annotatedPhotoTemplate(ctx.theme, await photoForRender(sourcePath), box, annotation),
          durationSec: slot.frames / FPS,
          outputPath: clipPath,
          browser: ctx.browser,
        });
        ctx.usedSources.add(sourceKey(candidate));
        return {
          clipPath,
          renderedType: fromArchive ? 'archive' : 'stock',
          ...source,
          note: [options.note, `annotated: ${annotation.label}`].filter(Boolean).join('; '),
          // Designed motion, not a slow pan over a still
          still: false,
        };
      }
      console.log(`[ShotRenderer] Beat ${ctx.beatIndex}: "${annotation.target}" not found (or not "${annotation.label}") in the photo; showing it plainly`);
    } catch (err) {
      console.warn(`[ShotRenderer] Beat ${ctx.beatIndex}: annotation failed (${err instanceof Error ? err.message.slice(0, 160) : err}); showing the photo plainly`);
    }
  }

  const shotSec = slot.frames / FPS;
  let startSec = 0;
  if (isVideo) {
    const sourceSec = await probeClipDurationSec(sourcePath);
    startSec =
      (await pickVideoSegment({ sourcePath, sourceSec, shotSec, shot, llm: ctx.llmProvider, llmCtx: ctx.llmCtx })) ??
      chooseVideoStart(sourceSec, shotSec);
  }

  // Historical shots from real archives get the archive texture; modern stock never does
  const archive = ctx.archiveLook;
  const historical = Boolean(archive) && shot.visual_type === 'archive' && HISTORICAL_PROVIDERS.has(candidate.provider);
  let archiveLook: ArchiveTreatment | undefined;
  if (archive && historical) {
    try {
      const under = !isVideo && archive.lastStill && archive.lastStill.key !== sourceKey(candidate) ? archive.lastStill.path : undefined;
      archiveLook = treatmentFor(archive.count.next++, await ensureArchiveTextures(), under);
    } catch (err) {
      console.warn(`[ShotRenderer] Beat ${ctx.beatIndex}: archive texture unavailable (${err instanceof Error ? err.message.slice(0, 120) : err}); rendering plainly`);
    }
  }

  await makeFootageClip({
    inputPath: sourcePath,
    isVideo,
    frames: slot.frames,
    outputPath: clipPath,
    startSec,
    motion: STILL_MOTIONS[ctx.motionCounter.next++ % STILL_MOTIONS.length],
    archiveLook,
  });
  if (archive && historical) archive.lastStill = isVideo ? undefined : { path: sourcePath, key: sourceKey(candidate) };
  ctx.usedSources.add(sourceKey(candidate));
  return applyCaption(options.captionShot ?? shot, slot, {
    clipPath,
    renderedType: fromArchive ? 'archive' : 'stock',
    ...source,
    note: options.note,
    still: !isVideo,
  }, ctx);
}

/**
 * Builds the beat's shot renderer. Specialised renderers handle their shot types; anything
 * without one, or whose renderer fails, falls back to footage searched from the shot's query,
 * so every shot still shows something relevant.
 */
export function createShotRenderer(
  ctx: ShotRenderContext,
  typed: Partial<Record<ShotType, TypedShotRenderer>> = {},
): ShotRenderer {
  /** Footage, or, when nothing relevant exists, the narration's words as a type card. */
  const footageOrText = async (shot: ShotPlan, slot: ShotSlot, clipPath: string, options: Parameters<typeof renderFootageShot>[4] = {}) => {
    try {
      return await renderFootageShot(shot, slot, clipPath, ctx, options);
    } catch (err) {
      if (!(err instanceof NoRelevantFootageError)) throw err;
      console.warn(`[ShotRenderer] Beat ${ctx.beatIndex}: ${err.message}; showing the narration as type instead`);
      const card = await renderTextCard(shot, slot, clipPath, ctx, [options.note, err.message].filter(Boolean).join('; '));
      // Marked so the composer can let neighbouring footage cover it instead
      return { ...card, fallback: true };
    }
  };

  return async (slot, clipPath) => {
    const shot = slot.shot;
    const specialised = typed[shot.visual_type];
    if (specialised) {
      try {
        return await specialised(shot, slot, clipPath, ctx);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[ShotRenderer] Beat ${ctx.beatIndex}: ${shot.visual_type} renderer failed (${reason.slice(0, 160)}); using footage`);
        return footageOrText(shot, slot, clipPath, {
          query: toStockQuery(shot.visual_query) || shot.covers,
          note: `${shot.visual_type} fallback: ${reason.slice(0, 200)}`,
        });
      }
    }
    if (shot.visual_type === 'stock' || shot.visual_type === 'archive') {
      return footageOrText(shot, slot, clipPath);
    }
    return footageOrText(shot, slot, clipPath, {
      query: toStockQuery(shot.visual_query) || shot.covers,
      note: `no ${shot.visual_type} renderer yet`,
    });
  };
}
