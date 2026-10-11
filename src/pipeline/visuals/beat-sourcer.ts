import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Browser } from 'playwright';
import type { LLMProvider, ProviderCallContext, StockProvider } from '../providers/types';
import type { FinalVisualType, VisualSourceResult, MediaCandidate } from './types';
import { executeChartStep } from './chart-step';
import { resolveOfficialUrl, recordUrlWithPlaywright } from './screen-recording-step';
import { executeStockStep } from './stock-step';
import { extractStockKeywords } from './stock-keywords';
import { upsertVideoAssetProvenance } from './provenance';
import { findExistingBeatUpload, normalizeLicenseType } from '../utils/media-upload';
import { aggregateMediaCandidates, downloadCandidateAsset } from './media-aggregator';
import { executeGeoMapStep } from './geo-map-step';
import { executeNewspaperStep } from './newspaper-step';

export interface BeatSourceInput {
  index: number;
  text: string;
  visual_type?: 'screen_recording' | 'stock' | 'chart' | 'archive' | 'geo_map' | 'newspaper';
  visual_query?: string;
  duration_estimate_seconds?: number;
}

export interface SourceBeatOptions {
  jobId: string;
  videoId?: string | null;
  beat: BeatSourceInput;
  targetDurationMs: number;
  outputDir: string;
  supabase: SupabaseClient;
  stockProvider: StockProvider;
  stockCtx: ProviderCallContext;
  llmProvider?: LLMProvider | null;
  llmCtx?: ProviderCallContext | null;
  browser?: Browser;
}

/**
 * Sources a single visual beat through chart, screen recording, or stock pathways,
 * with automatic fallback to stock and provenance logging into video_assets.
 */
export async function sourceVisualBeat(
  options: SourceBeatOptions,
): Promise<VisualSourceResult> {
  const {
    jobId,
    videoId,
    beat,
    targetDurationMs,
    outputDir,
    supabase,
    stockProvider,
    stockCtx,
    llmProvider,
    llmCtx,
    browser,
  } = options;

  const beatIndex = beat.index;
  const targetDurationSeconds = Math.max(1, targetDurationMs / 1000);
  const requestedType = beat.visual_type || 'stock';
  const query = beat.visual_query?.trim() || beat.text.trim();

  let finalVisualType: FinalVisualType = requestedType;
  let finalOutputPath = '';
  let sourceUrl: string | null = null;
  let licenseType: string | null = null;
  let licenseSource: string | null = null;
  let licenseProofUrl: string | null = null;
  let attributionText: string | null = null;
  let fallbackOccurred = false;
  let fallbackReason: string | undefined;

  // -------------------------------------------------------------
  // MANUAL UPLOAD CHECK: Skip auto-sourcing if already uploaded and never overwrite
  // -------------------------------------------------------------
  if (videoId) {
    const { data: existingAsset } = await supabase
      .from('video_assets')
      .select('visual_type, source_url, license_type, license_source, attribution_text, license_proof_url')
      .eq('video_id', videoId)
      .eq('beat_index', beatIndex)
      .maybeSingle();

    if (existingAsset && existingAsset.visual_type === 'uploaded') {
      const existingUpload = await findExistingBeatUpload(videoId, beatIndex);
      return {
        outputPath: existingUpload?.filePath || '',
        finalVisualType: 'uploaded',
        durationMs: targetDurationMs,
        sourceUrl: existingAsset.source_url,
        licenseType: existingAsset.license_type,
        licenseSource: existingAsset.license_source,
        licenseProofUrl: existingAsset.license_proof_url,
        attributionText: existingAsset.attribution_text,
        fallbackOccurred: false,
      };
    }
  }

  // -------------------------------------------------------------
  // PATHWAY 1: CHART
  // -------------------------------------------------------------
  if (requestedType === 'chart') {
    if (!llmProvider || !llmCtx) {
      fallbackOccurred = true;
      fallbackReason = 'No LLM provider configured for "script" stage (needed for chart extraction)';
      console.warn(
        `[Visuals] Beat ${beatIndex}: Chart skipped (${fallbackReason}). Falling back to stock sourcing.`,
      );
    } else {
      const chartPngPath = path.join(outputDir, `visuals_beat_${beatIndex}.png`);
      const chartResult = await executeChartStep(
        { text: beat.text, visualQuery: beat.visual_query, beatIndex },
        chartPngPath,
        llmProvider,
        llmCtx,
        browser,
      );

      if (chartResult.success && chartResult.outputPath) {
        finalVisualType = 'chart';
        finalOutputPath = chartResult.outputPath;
      } else {
        fallbackOccurred = true;
        fallbackReason = chartResult.reason || 'Unchartable content';
        console.warn(
          `[Visuals] Beat ${beatIndex}: Chart failed/unchartable (${fallbackReason}). Falling back to stock sourcing.`,
        );
      }
    }
  }

  // -------------------------------------------------------------
  // PATHWAY 2: SCREEN RECORDING
  // -------------------------------------------------------------
  if (requestedType === 'screen_recording') {
    if (!llmProvider || !llmCtx) {
      fallbackOccurred = true;
      fallbackReason = 'No LLM provider configured for "script" stage (needed for URL resolution)';
      console.warn(
        `[Visuals] Beat ${beatIndex}: Screen recording skipped (${fallbackReason}). Falling back to stock sourcing.`,
      );
    } else {
      const urlResolution = await resolveOfficialUrl(
        { visualQuery: query, text: beat.text, beatIndex },
        llmProvider,
        llmCtx,
      );

      if (urlResolution.resolved && urlResolution.url) {
        const screenMp4Path = path.join(outputDir, `visuals_beat_${beatIndex}.mp4`);
        const tempRecDir = path.join(outputDir, `temp_rec_${beatIndex}`);

        const recResult = await recordUrlWithPlaywright(
          urlResolution.url,
          targetDurationSeconds,
          screenMp4Path,
          tempRecDir,
          browser,
        );

        if (recResult.success && recResult.outputPath) {
          finalVisualType = 'screen_recording';
          finalOutputPath = recResult.outputPath;
          sourceUrl = urlResolution.url;
        } else {
          fallbackOccurred = true;
          fallbackReason = recResult.error || 'Screen recording failed';
          console.warn(
            `[Visuals] Beat ${beatIndex}: Screen recording failed for ${urlResolution.url} (${fallbackReason}). Falling back to stock sourcing.`,
          );
        }
      } else {
        fallbackOccurred = true;
        fallbackReason = urlResolution.reason || 'Could not resolve official URL';
        console.warn(
          `[Visuals] Beat ${beatIndex}: URL resolution failed (${fallbackReason}). Falling back to stock sourcing.`,
        );
      }
    }
  }

  // -------------------------------------------------------------
  // PATHWAY 2.5: ANIMATED GEO-MAP
  // -------------------------------------------------------------
  if (requestedType === 'geo_map') {
    const mapMp4Path = path.join(outputDir, `visuals_beat_${beatIndex}.mp4`);
    const tempMapDir = path.join(outputDir, `temp_map_${beatIndex}`);

    const mapResult = await executeGeoMapStep({
      text: beat.text,
      visualQuery: beat.visual_query,
      durationSeconds: targetDurationSeconds,
      outputMp4Path: mapMp4Path,
      tempDir: tempMapDir,
      browser,
    });

    if (mapResult.success && mapResult.outputPath) {
      finalVisualType = 'geo_map';
      finalOutputPath = mapResult.outputPath;
      licenseType = 'public_domain';
      licenseSource = 'openstreetmap';
      licenseProofUrl = 'https://www.openstreetmap.org/copyright';
      attributionText = 'OpenStreetMap contributors / CartoDB';
    } else {
      fallbackOccurred = true;
      fallbackReason = mapResult.error || 'Geo map generation failed';
      console.warn(
        `[Visuals] Beat ${beatIndex}: Geo-map failed (${fallbackReason}). Falling back to stock sourcing.`,
      );
    }
  }

  // -------------------------------------------------------------
  // PATHWAY 2.6: ANIMATED NEWSPAPER HEADLINE
  // -------------------------------------------------------------
  if (requestedType === 'newspaper') {
    const newsMp4Path = path.join(outputDir, `visuals_beat_${beatIndex}.mp4`);
    const tempNewsDir = path.join(outputDir, `temp_news_${beatIndex}`);

    const newsResult = await executeNewspaperStep({
      text: beat.text,
      visualQuery: beat.visual_query,
      durationSeconds: targetDurationSeconds,
      outputMp4Path: newsMp4Path,
      tempDir: tempNewsDir,
      llmProvider,
      llmCtx,
      browser,
      asVideo: true,
    });

    if (newsResult.success && newsResult.outputPath) {
      finalVisualType = 'newspaper';
      finalOutputPath = newsResult.outputPath;
      licenseType = 'public_domain';
      licenseSource = 'generated';
      attributionText = `Archival Broadside: ${newsResult.spec?.outlet || 'Press Archive'}`;
    } else {
      fallbackOccurred = true;
      fallbackReason = newsResult.error || 'Newspaper generation failed';
      console.warn(
        `[Visuals] Beat ${beatIndex}: Newspaper visual failed (${fallbackReason}). Falling back to stock sourcing.`,
      );
    }
  }

  // -------------------------------------------------------------
  // PATHWAY 3: MULTI-SOURCE MEDIA GATHERING (Stock, Archives, NASA)
  // -------------------------------------------------------------
  let mediaCandidates: MediaCandidate[] = [];
  if (requestedType === 'stock' || requestedType === 'archive' || fallbackOccurred) {
    const stockSearchQuery = await extractStockKeywords(
      query,
      llmProvider,
      llmCtx,
    );

    try {
      const aggResult = await aggregateMediaCandidates({
        query: stockSearchQuery,
        text: beat.text,
        explicitType: requestedType,
        targetDurationSeconds,
        stockProvider,
        stockCtx,
        limit: 5,
      });
      mediaCandidates = aggResult.candidates;
    } catch (err) {
      console.warn(`[Visuals] Multi-source aggregation error for beat ${beatIndex}:`, err);
    }

    if (mediaCandidates.length > 0) {
      const topCandidate = mediaCandidates[0];
      const isVid = topCandidate.mediaType === 'video';
      const ext = isVid ? '.mp4' : '.jpg';
      const candidateOutPath = path.join(outputDir, `visuals_beat_${beatIndex}${ext}`);

      await downloadCandidateAsset(topCandidate, candidateOutPath, stockCtx, stockProvider);

      finalOutputPath = candidateOutPath;
      finalVisualType = fallbackOccurred
        ? 'stock'
        : topCandidate.provider === 'pixabay' || topCandidate.provider === 'pexels'
        ? 'stock'
        : 'archive';
      sourceUrl = topCandidate.pageUrl || topCandidate.downloadUrl;
      licenseType = normalizeLicenseType(
        fallbackOccurred || topCandidate.provider === 'pixabay' || topCandidate.provider === 'pexels'
          ? 'royalty_free'
          : topCandidate.license || 'public_domain',
      );
      licenseSource = topCandidate.provider;
      licenseProofUrl = topCandidate.licenseProofUrl || null;
      attributionText =
        topCandidate.attribution ||
        (licenseType === 'cc_by' ? `${topCandidate.title} via ${topCandidate.provider}` : null);
    } else {
      const stockMp4Path = path.join(outputDir, `visuals_beat_${beatIndex}.mp4`);
      const stockResult = await executeStockStep(
        stockSearchQuery,
        targetDurationSeconds,
        stockMp4Path,
        stockProvider,
        stockCtx,
      );

      finalVisualType = 'stock';
      finalOutputPath = stockResult.outputPath;
      sourceUrl = stockResult.candidate.pageUrl || stockResult.candidate.url;
      licenseType = 'royalty_free';
      licenseSource = stockProvider.id || 'pixabay';
      licenseProofUrl =
        stockProvider.id === 'pexels'
          ? 'https://www.pexels.com/license/'
          : 'https://pixabay.com/service/license-summary/';
      attributionText = stockResult.candidate.attribution || null;
    }
  }

  // -------------------------------------------------------------
  // PROVENANCE LOGGING: Upsert video_assets row
  // -------------------------------------------------------------
  if (videoId) {
    await upsertVideoAssetProvenance(supabase, {
      video_id: videoId,
      beat_index: beatIndex,
      visual_type: finalVisualType, // Reflects FINAL asset type actually used!
      source_url: sourceUrl,
      license_type: licenseType,
      license_source: licenseSource,
      attribution_text: attributionText,
      license_proof_url: licenseProofUrl,
      candidates_json: mediaCandidates.length > 0 ? mediaCandidates : null,
    });
  }

  return {
    outputPath: finalOutputPath,
    finalVisualType,
    durationMs: targetDurationMs,
    sourceUrl,
    licenseType,
    licenseSource,
    licenseProofUrl,
    attributionText,
    fallbackOccurred,
    fallbackReason,
    candidates: mediaCandidates.length > 0 ? mediaCandidates : undefined,
  };
}
