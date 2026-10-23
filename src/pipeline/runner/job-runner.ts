import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '../providers/registry';
import { runJobUnit } from './unit-runner';
import { getAudioDurationMs } from '../utils/ffmpeg';
import { computeInputHash, computeScriptFingerprint } from '../utils/hash';
import { chromium, type Browser } from 'playwright';
import type { ImageProvider, LLMProvider, PipelineStage, StockProvider } from '../providers/types';
import { sourceVisualBeat } from '../visuals/beat-sourcer';
import { findExistingBeatUpload } from '../utils/media-upload';
import { checkAssemblyGate } from '../assembly/gate';
import {
  renderBeatScene,
  joinSceneClips,
  probeClipDurationSec,
  computeSceneStartOffsetsSec,
} from '../assembly/assemble-beat';
import { isCaptionPreset, writeAssCaptionsFile } from '../assembly/captions';
import { masterFinalVideo, TARGET_LUFS } from '../assembly/master';
import { DEFAULT_BEAT_PAUSE_SEC, planPacing, type BeatPacing } from '../assembly/pacing';
import { ensureSections } from '../assembly/sections';
import { readSidecar } from '../visuals/shot-editor';
import { captionZonesFromTracks, loadCaptionWords } from '../assembly/caption-sources';
import { applySoundDesign, planSoundCues } from '../assembly/sound-design';
import { narrationSoundCues } from '../assembly/narration-sounds';
import { applyPalette } from '../assembly/palettes';
import { prepareEmphasis } from '../assembly/emphasis';
import { planTransitions, startsFromOverlaps, type TransitionIntensity } from '../assembly/transitions';
import { ensureMusicPlan, musicCredits, pickMusic } from '../assembly/music-plan';
import { buildMusicBed } from '../assembly/music-bed';
import { accentExpression, accentTimes, ensureMusicMoments, stingPath } from '../assembly/music-accents';
import { lookFilter } from '../assembly/look';
import { runFinalQualityCheck, type QualityReport } from '../assembly/final-check';
import { generateMetadata, type VideoMetadata } from '../publish/metadata';
import { generateThumbnails } from '../publish/publish-assets';
import type { Thumbnail } from '../publish/thumbnails';
import type { VideoTimeline } from '../utils/timeline';
import { resolveBgmTrackPath, applyBackgroundMusic } from '../assembly/bgm';
import { ensureDefaultSfxPresets, resolveSfxPath } from '../assembly/sfx';
import { generateYouTubeChapters } from '../utils/chapters';
import { mapWithConcurrency, resolveTtsSetup, voiceBeat } from '../tts/voice-beat';
import { composeShotBeat, hasUploadedVisual } from '../visuals/compose-beat-visual';
import { saveRenderedRhythm } from '../visuals/rhythm-report';
import { themeForStyle } from '../visuals/motion/theme';
import { withWritingModel, type ScriptBeat } from '@/lib/script/generate-script';
import { stylePack } from '@/lib/styles/packs';

export const ScriptSceneSchema = z.object({
  scene_number: z.number(),
  narration: z.string(),
  visual_prompt: z.string(),
  visual_type: z
    .enum(['screen_recording', 'stock', 'chart', 'geo_map', 'archive', 'newspaper'])
    .optional(),
  visual_query: z.string().optional(),
  duration_estimate_seconds: z.number().optional(),
});

export type ScriptScene = z.infer<typeof ScriptSceneSchema>;

export const ScriptSchema = z.object({
  title: z.string().optional(),
  visual_style: z.string().optional(),
  scenes: z.array(ScriptSceneSchema),
});

export type ScriptData = z.infer<typeof ScriptSchema>;

export const MetadataSchema = z.object({
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
});

export interface JobRow {
  id: string;
  video_id?: string | null;
  topic: string;
  template: string;
  status: 'queued' | 'running' | 'failed' | 'done' | 'cancelled';
  stages?: string[] | null;
  script: ScriptData | null;
  script_fingerprint: string | null;
  error: string | null;
}

export interface JobRunnerOptions {
  jobId: string;
  supabase: SupabaseClient;
  baseOutputDir?: string;
  signal?: AbortSignal;
}

export class JobRunner {
  private jobId: string;
  private supabase: SupabaseClient;
  private baseOutputDir: string;
  private signal?: AbortSignal;

  constructor(options: JobRunnerOptions) {
    this.jobId = options.jobId;
    this.supabase = options.supabase;
    this.baseOutputDir =
      options.baseOutputDir ||
      path.join(process.cwd(), 'storage', 'jobs', options.jobId);
    this.signal = options.signal;
  }

  private async updateJob(updates: Partial<JobRow>): Promise<void> {
    await this.supabase
      .from('yt_jobs')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', this.jobId);
  }

  private async getJob(): Promise<JobRow> {
    const { data, error } = await this.supabase
      .from('yt_jobs')
      .select('*')
      .eq('id', this.jobId)
      .single();

    if (error || !data) {
      throw new Error(`Failed to load job ${this.jobId}: ${error?.message}`);
    }

    return data as unknown as JobRow;
  }

  private async updateStageStatus(
    stage: PipelineStage,
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped',
    errorMsg?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const updatePayload: Record<string, unknown> = {
      status,
      error: errorMsg ?? null,
    };
    if (status === 'running') {
      updatePayload.started_at = now;
    } else if (status === 'done' || status === 'failed') {
      updatePayload.finished_at = now;
    }

    await this.supabase.from('yt_job_stages').upsert(
      {
        job_id: this.jobId,
        stage,
        ...updatePayload,
      },
      { onConflict: 'job_id,stage' },
    );
  }

  private async isStageDone(stage: PipelineStage): Promise<boolean> {
    const { data } = await this.supabase
      .from('yt_job_stages')
      .select('status')
      .eq('job_id', this.jobId)
      .eq('stage', stage)
      .maybeSingle();

    return data?.status === 'done';
  }

  /**
   * Synchronizes pipeline progress to the front-door `videos` table at stage boundaries.
   */
  private async syncVideoStatus(
    stageOrEvent: PipelineStage | 'done' | 'failed',
    state: 'start' | 'done' | 'failed',
    payload?: { outputPath?: string; error?: string },
  ): Promise<void> {
    try {
      const job = await this.getJob();
      if (!job.video_id) return;

      if (state === 'failed') {
        await this.supabase
          .from('videos')
          .update({
            status: 'failed',
            error_message: payload?.error || `Job failed at stage: ${stageOrEvent}`,
          })
          .eq('id', job.video_id);
        return;
      }

      if (stageOrEvent === 'done' || (state === 'done' && stageOrEvent === 'assembly')) {
        const updates: Record<string, unknown> = {
          status: 'rendered',
        };
        if (payload?.outputPath) {
          updates.render_url = payload.outputPath;
        }
        await this.supabase
          .from('videos')
          .update(updates)
          .eq('id', job.video_id);
        return;
      }

      if (state === 'start') {
        let videoStatus: string | null = null;
        if (stageOrEvent === 'tts') {
          videoStatus = 'voicing';
        } else if (stageOrEvent === 'image' || stageOrEvent === 'visuals') {
          videoStatus = 'sourcing';
        } else if (stageOrEvent === 'assembly') {
          videoStatus = 'assembling';
        }

        if (videoStatus) {
          await this.supabase
            .from('videos')
            .update({ status: videoStatus })
            .eq('id', job.video_id);
        }
      }
    } catch (err) {
      console.warn(`[JobRunner] Warning: failed to sync video status for job ${this.jobId}:`, err);
    }
  }

  /**
   * Runs the pipeline stages specified in job.stages (or all default stages if unset).
   * Does NOT pre-insert 'done' rows for skipped stages.
   */
  async run(): Promise<void> {
    const job = await this.getJob();
    if (job.status === 'cancelled') {
      return;
    }

    await this.updateJob({ status: 'running', error: null });

    const defaultStages: PipelineStage[] = [
      'research',
      'script',
      'image',
      'tts',
      'assembly',
      'thumbnail',
      'metadata',
    ];

    const stagesToRun: PipelineStage[] = (
      job.stages && job.stages.length > 0 ? job.stages : defaultStages
    ) as PipelineStage[];

    let lastOutputPath: string | undefined;

    try {
      for (const stage of stagesToRun) {
        if (this.signal?.aborted) {
          throw new Error('Job execution aborted');
        }

        await this.syncVideoStatus(stage, 'start');

        switch (stage) {
          case 'research':
            await this.runResearchStage();
            break;
          case 'script':
            await this.runScriptStage();
            break;
          case 'image':
            await this.runImageStage();
            break;
          case 'visuals':
            await this.runVisualsStage();
            break;
          case 'tts':
            await this.runTtsStage();
            break;
          case 'assembly':
            lastOutputPath = await this.runAssemblyStage();
            break;
          case 'thumbnail':
            await this.runThumbnailStage();
            break;
          case 'metadata':
            await this.runMetadataStage();
            break;
          default:
            console.warn(`[JobRunner] Unknown stage '${stage}', skipping`);
            break;
        }

        await this.syncVideoStatus(stage, 'done', { outputPath: lastOutputPath });
      }

      await this.updateJob({ status: 'done', error: null });
      await this.syncVideoStatus('done', 'done', { outputPath: lastOutputPath });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.updateJob({ status: 'failed', error: errMsg });
      await this.syncVideoStatus('failed', 'failed', { error: errMsg });
      throw err;
    }
  }

  async runVisualsStage(): Promise<void> {
    if (await this.isStageDone('visuals')) {
      return;
    }

    await this.updateStageStatus('visuals', 'running');
    try {
      const job = await this.getJob();
      if (!job.script || !job.script.scenes || job.script.scenes.length === 0) {
        throw new Error('Cannot run visuals stage without approved script scenes');
      }

      // 1. Resolve stock provider for the 'visuals' stage
      const stock = await resolveForStage<StockProvider>('visuals', this.supabase);

      // 2. Resolve LLM provider for chart extraction and URL resolution
      // Reuses the 'script' stage LLM binding if available
      let llm: Awaited<ReturnType<typeof resolveForStage<LLMProvider>>> | null = null;
      const getScriptLlm = async (): Promise<typeof llm> => {
        if (llm) return llm;
        try {
          llm = await resolveForStage<LLMProvider>('script', this.supabase);
          return llm;
        } catch {
          return null;
        }
      };

      await getScriptLlm();
      if (!llm) {
        console.warn(
          '[JobRunner] No LLM provider initially configured for "script" stage. Will dynamically re-check per chart/screen_recording beat.',
        );
      }

      // 3. Fetch all completed TTS units for this job to use real measured duration_ms
      const { data: ttsUnits } = await this.supabase
        .from('yt_job_units')
        .select('unit_index, duration_ms, status, output_path')
        .eq('job_id', this.jobId)
        .eq('stage', 'tts')
        .eq('status', 'done');

      const ttsDurationMap = new Map<number, number>();
      const ttsAudioMap = new Map<number, string>();
      if (ttsUnits) {
        for (const u of ttsUnits) {
          if (u.duration_ms != null && u.duration_ms > 0) {
            ttsDurationMap.set(u.unit_index, u.duration_ms);
          }
          if (u.output_path) ttsAudioMap.set(u.unit_index, u.output_path);
        }
      }

      // Beats with a director's shot plan are composed shot by shot (cut on the narration's
      // word timings); the rest are sourced as one visual per beat
      const { data: videoRow } = job.video_id
        ? await this.supabase.from('videos').select('style, topic, script_json').eq('id', job.video_id).maybeSingle()
        : { data: null };
      const plannedBeats: ScriptBeat[] = Array.isArray(videoRow?.script_json?.beats) ? videoRow.script_json.beats : [];
      const theme = themeForStyle(videoRow?.style);
      // Pacing is built into composed tracks (no frozen frames), so it's planned before composing
      const pacing = job.video_id && plannedBeats.length
        ? planPacing(
            plannedBeats.map((b, i) => ({ index: i, text: b.text })),
            await ensureSections({ supabase: this.supabase, videoId: job.video_id, scriptJson: videoRow!.script_json, topic: videoRow?.topic, llm }),
            Number(videoRow?.script_json?.beat_pause_seconds ?? DEFAULT_BEAT_PAUSE_SEC),
          )
        : new Map<number, BeatPacing>();
      const archiveLookOn = videoRow?.script_json?.archive_look !== 'off';
      const sharedRenderState = {
        usedSources: new Set<string>(),
        motionCounter: { next: 0 },
        ...(archiveLookOn ? { archiveLook: { count: { next: 0 } } } : {}),
        ...(stylePack(videoRow?.style)?.photoLook === 'collage' ? { collage: { count: { next: 0 } } } : {}),
        ...(videoRow?.script_json?.parallax !== false ? { parallax: { count: { next: 0 } } } : {}),
      };

      const outputDir = path.join(this.baseOutputDir, 'visuals');
      let hasFailure = false;

      // Launch headless browser for rendering charts / screen recordings
      let browser: Browser | undefined;
      try {
        browser = await chromium.launch({ headless: true });
      } catch (browserErr) {
        console.warn(`[JobRunner] Playwright browser launch failed:`, browserErr);
      }

      try {
        for (const scene of job.script.scenes) {
          if (this.signal?.aborted) {
            throw new Error('Visuals stage aborted');
          }

          // HARD REQUIREMENT: Use real measured duration_ms from TTS unit for visual sizing!
          const measuredTtsDurationMs = ttsDurationMap.get(scene.scene_number);
          const targetDurationMs = measuredTtsDurationMs ?? (
            scene.duration_estimate_seconds ? Math.round(scene.duration_estimate_seconds * 1000) : 5000
          );

          const plannedBeat = plannedBeats[scene.scene_number];
          const audioPath = ttsAudioMap.get(scene.scene_number);
          const composeShots = Boolean(
            job.video_id &&
              plannedBeat?.shots?.length &&
              audioPath &&
              measuredTtsDurationMs &&
              !(await hasUploadedVisual(this.supabase, job.video_id, scene.scene_number)),
          );

          const result = await runJobUnit({
            jobId: this.jobId,
            stage: 'visuals',
            unitIndex: scene.scene_number,
            input: {
              sceneNumber: scene.scene_number,
              visualType: scene.visual_type,
              visualQuery: scene.visual_query,
              narration: scene.narration,
              targetDurationMs,
              // A changed shot plan or look re-renders the beat
              ...(composeShots
                ? {
                    shots: plannedBeat!.shots,
                    theme: theme.name,
                    composer: 'shots-v2-paced',
                    // Switching the archive texture re-renders composed beats
                    archiveLook: archiveLookOn ? 'on' : 'off',
                    photoLook: stylePack(videoRow?.style)?.photoLook ?? 'plain',
                    parallax: videoRow?.script_json?.parallax !== false ? 'on' : 'off',
                    leadInSec: pacing.get(scene.scene_number)?.leadInSec ?? 0,
                    tailSec: pacing.get(scene.scene_number)?.tailSec ?? 0,
                  }
                : {}),
            },
            providerConfigId: stock.configId,
            providerId: stock.providerId,
            model: stock.model,
            baseUrl: stock.ctx.baseUrl,
            options: stock.options,
            maxRetries: stock.maxRetries,
            supabase: this.supabase,
            outputDir,
            signal: this.signal,
            execute: async () => {
              if (composeShots) {
                const scriptLlm = await getScriptLlm();
                return composeShotBeat({
                  supabase: this.supabase,
                  videoId: job.video_id!,
                  beat: { ...plannedBeat!, index: scene.scene_number },
                  audioPath: audioPath!,
                  audioDurationMs: measuredTtsDurationMs!,
                  outputDir,
                  renderContext: {
                    theme,
                    browser,
                    stockProvider: stock.provider,
                    stockCtx: stock.ctx,
                    llmProvider: scriptLlm?.provider,
                    llmCtx: scriptLlm?.ctx,
                    ...sharedRenderState,
                  },
                  pacing: pacing.get(scene.scene_number),
                });
              }

              // Dynamically re-check for LLM provider if not previously resolved
              let activeLlm = llm;
              if (!activeLlm && (scene.visual_type === 'chart' || scene.visual_type === 'screen_recording')) {
                activeLlm = await getScriptLlm();
              }

              const sourced = await sourceVisualBeat({
                jobId: this.jobId,
                videoId: job.video_id,
                beat: {
                  index: scene.scene_number,
                  text: scene.narration,
                  visual_type: scene.visual_type,
                  visual_query: scene.visual_query,
                  duration_estimate_seconds: scene.duration_estimate_seconds,
                },
                targetDurationMs,
                outputDir,
                supabase: this.supabase,
                stockProvider: stock.provider,
                stockCtx: stock.ctx,
                llmProvider: activeLlm?.provider,
                llmCtx: activeLlm?.ctx,
                browser,
              });

              return {
                outputPath: sourced.outputPath,
                durationMs: sourced.durationMs,
              };
            },
          });

          if (!result.success) {
            hasFailure = true;
          }
        }
      } finally {
        if (browser) {
          await browser.close().catch(() => {});
        }
      }

      if (hasFailure) {
        await this.updateStageStatus('visuals', 'failed', 'One or more visual beat units failed');
        throw new Error('Visuals stage failed: one or more units failed');
      }

      if (job.video_id) {
        // Report only: a failure here never fails the stage
        const rhythm = await saveRenderedRhythm(this.supabase, job.video_id).catch((err) => {
          console.warn('[Visuals] Rhythm report failed:', err instanceof Error ? err.message : err);
          return null;
        });
        if (rhythm) {
          console.log(`[Visuals] Visual rhythm ${rhythm.score}/100 (${rhythm.risk} slideshow risk): ${rhythm.issues.length} issue(s)`);
        }
      }

      await this.updateStageStatus('visuals', 'done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.updateStageStatus('visuals', 'failed', msg);
      throw err;
    }
  }

  async runResearchStage(): Promise<string> {
    if (await this.isStageDone('research')) {
      return 'Research stage already complete';
    }

    await this.updateStageStatus('research', 'running');
    try {
      const job = await this.getJob();
      const { provider, ctx } = await resolveForStage<LLMProvider>('research', this.supabase);

      const prompt = `Conduct in-depth research for a YouTube video.\nTopic: ${job.topic}\nFormat/Template: ${job.template}\nProvide key talking points, factual hooks, and an engaging narrative outline.`;
      const response = await provider.generateText(
        {
          system: 'You are an expert YouTube research analyst.',
          prompt,
        },
        ctx,
      );

      await this.updateStageStatus('research', 'done');
      return response.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.updateStageStatus('research', 'failed', msg);
      throw err;
    }
  }

  async runScriptStage(): Promise<ScriptData> {
    const job = await this.getJob();

    // If script is already approved and fingerprinted on the job, use it!
    if (job.script && job.script_fingerprint) {
      await this.updateStageStatus('script', 'done');
      return job.script;
    }

    if (await this.isStageDone('script') && job.script) {
      return job.script;
    }

    await this.updateStageStatus('script', 'running');
    try {
      const { provider, ctx } = await resolveForStage<LLMProvider>('script', this.supabase);

      const prompt = `Write a comprehensive YouTube video script for:\nTopic: ${job.topic}\nTemplate: ${job.template}\nGenerate scenes with scene_number (starting from 1), visual_prompt (describing scene visuals in high detail), and narration (voiceover text).`;

      const response = await provider.generateJson(
        {
          system: 'You are a professional YouTube scriptwriter.',
          prompt,
          schema: ScriptSchema,
        },
        ctx,
      );

      const script = response.data;
      const scriptFingerprint = computeScriptFingerprint(script);

      await this.updateJob({
        script,
        script_fingerprint: scriptFingerprint,
      });

      await this.updateStageStatus('script', 'done');
      return script;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.updateStageStatus('script', 'failed', msg);
      throw err;
    }
  }

  async runImageStage(): Promise<void> {
    const job = await this.getJob();
    if (!job.script || !job.script.scenes || job.script.scenes.length === 0) {
      throw new Error('Cannot run image stage without approved script scenes');
    }

    await this.updateStageStatus('image', 'running');
    const { provider, ctx, maxRetries, configId, providerId, model, options } =
      await resolveForStage<ImageProvider>('image', this.supabase);

    let hasFailure = false;
    const outputDir = path.join(this.baseOutputDir, 'images');

    for (const scene of job.script.scenes) {
      const prompt = job.script.visual_style
        ? `${scene.visual_prompt}, in style of ${job.script.visual_style}`
        : scene.visual_prompt;

      const result = await runJobUnit({
        jobId: this.jobId,
        stage: 'image',
        unitIndex: scene.scene_number,
        input: {
          prompt,
          width: 1792,
          height: 1024,
        },
        providerConfigId: configId,
        providerId,
        model,
        baseUrl: ctx.baseUrl,
        options,
        maxRetries,
        supabase: this.supabase,
        outputDir,
        signal: this.signal,
        execute: async () => {
          return await provider.generate(
            {
              prompt,
              width: 1792,
              height: 1024,
            },
            ctx,
          );
        },
      });

      if (!result.success) {
        hasFailure = true;
      }
    }

    if (hasFailure) {
      await this.updateStageStatus('image', 'failed', 'One or more image scene units failed');
      throw new Error('Image stage failed: one or more units failed');
    }

    await this.updateStageStatus('image', 'done');
  }

  async runTtsStage(): Promise<void> {
    if (await this.isStageDone('tts')) {
      return;
    }

    const job = await this.getJob();
    if (!job.script || !job.script.scenes || job.script.scenes.length === 0) {
      throw new Error('Cannot run TTS stage without approved script scenes');
    }

    await this.updateStageStatus('tts', 'running');
    const setup = await resolveTtsSetup(this.supabase, job as Parameters<typeof resolveTtsSetup>[1]);
    const outputDir = path.join(this.baseOutputDir, 'audio');
    // Cloud voices can run several beats at once; a local engine on one CPU stays sequential
    const concurrency = setup.resolved.provider.maxConcurrency ?? 1;

    const results = await mapWithConcurrency(job.script.scenes, concurrency, (scene) => {
      if (this.signal?.aborted) {
        return Promise.resolve({ skipped: false, success: false, error: 'TTS stage aborted' });
      }
      return voiceBeat({
        supabase: this.supabase,
        setup,
        jobId: this.jobId,
        unitIndex: scene.scene_number,
        narration: scene.narration,
        outputDir,
        signal: this.signal,
      });
    });
    const hasFailure = results.some((r) => !r.success);

    if (hasFailure) {
      await this.updateStageStatus('tts', 'failed', 'One or more TTS scene units failed');
      throw new Error('TTS stage failed: one or more units failed');
    }

    await this.updateStageStatus('tts', 'done');
  }

  async runAssemblyStage(): Promise<string> {
    const job = await this.getJob();
    const videoId = job.video_id;

    const finalRenderPath = videoId
      ? path.join(process.cwd(), 'storage', 'renders', videoId, 'final_video.mp4')
      : path.join(this.baseOutputDir, 'final_video.mp4');

    if (await this.isStageDone('assembly')) {
      const exists = await fs
        .stat(finalRenderPath)
        .then((s) => s.isFile() && s.size > 0)
        .catch(() => false);
      if (exists) {
        return finalRenderPath;
      }
    }

    await this.updateStageStatus('assembly', 'running');
    try {
      // 1. If videoId is present, enforce assembly gate: every beat must have an asset
      if (videoId) {
        const gateResult = await checkAssemblyGate(this.supabase, videoId);
        if (!gateResult.ready) {
          throw new Error(
            gateResult.error ||
              `Assembly refused: missing visual assets for beats [${gateResult.missingBeats.join(', ')}]`,
          );
        }
      }

      // 2. Resolve beats / scenes
      // An untyped select('*') row whose script_json holds many optional, evolving settings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let videoRecord: any = null;
      if (videoId) {
        const { data: vRec } = await this.supabase
          .from('videos')
          .select('*')
          .eq('id', videoId)
          .maybeSingle();
        videoRecord = vRec;
      }

      const usingVideoBeats = Array.isArray(videoRecord?.script_json?.beats);
      // Either video beats or legacy job scenes; both shapes are read field by field below
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scriptBeats: any[] =
        videoRecord?.script_json?.beats || job.script?.scenes;

      if (!scriptBeats || !Array.isArray(scriptBeats) || scriptBeats.length === 0) {
        throw new Error('No script beats available for assembly');
      }

      // 3. Resolve TTS units (measured duration_ms and audio output_path)
      // Query completed TTS units for this job or from previous jobs for this video
      let ttsUnits: Array<{
        unit_index: number;
        output_path: string | null;
        duration_ms: number | null;
      }> = [];

      const { data: currentJobTts } = await this.supabase
        .from('yt_job_units')
        .select('unit_index, output_path, duration_ms')
        .eq('job_id', this.jobId)
        .eq('stage', 'tts')
        .eq('status', 'done');

      if (currentJobTts && currentJobTts.length > 0) {
        ttsUnits = currentJobTts;
      }

      if (ttsUnits.length < scriptBeats.length && videoId) {
        // Query sibling jobs for this video ordered latest first
        const { data: siblingJobs } = await this.supabase
          .from('yt_jobs')
          .select('id')
          .eq('video_id', videoId)
          .order('created_at', { ascending: false });

        if (siblingJobs && siblingJobs.length > 0) {
          const siblingJobIds = siblingJobs.map((j) => j.id);
          const { data: siblingUnits } = await this.supabase
            .from('yt_job_units')
            .select('unit_index, output_path, duration_ms, job_id')
            .in('job_id', siblingJobIds)
            .eq('stage', 'tts')
            .eq('status', 'done');

          if (siblingUnits && siblingUnits.length > 0) {
            const unitByBeat = new Map<
              number,
              { unit_index: number; output_path: string | null; duration_ms: number | null }
            >();
            for (const u of ttsUnits) {
              unitByBeat.set(u.unit_index, u);
            }
            for (const j of siblingJobs) {
              const matching = siblingUnits.filter((u) => u.job_id === j.id);
              for (const m of matching) {
                if (!unitByBeat.has(m.unit_index)) {
                  unitByBeat.set(m.unit_index, m);
                }
              }
            }
            ttsUnits = Array.from(unitByBeat.values());
          }
        }
      }

      const ttsMap = new Map(ttsUnits.map((u) => [u.unit_index, u]));

      // 4. Temporary workspace for assembly clips
      const tempDir = path.join(this.baseOutputDir, 'temp_assembly');
      await fs.mkdir(tempDir, { recursive: true });

      // Sections (chapters) and the pacing between beats, the same plan the visuals stage used
      const beatIndexAt = (i: number): number =>
        !usingVideoBeats && typeof scriptBeats[i]?.scene_number === 'number' ? scriptBeats[i].scene_number : i;
      const sections =
        videoId && usingVideoBeats
          ? await ensureSections({
              supabase: this.supabase,
              videoId,
              scriptJson: videoRecord.script_json,
              topic: videoRecord?.topic,
              llm: await resolveForStage<LLMProvider>('script', this.supabase).catch(() => null),
            })
          : [];
      const pacingPlan = planPacing(
        scriptBeats.map((b, i) => ({ index: beatIndexAt(i), text: String(b.text ?? b.narration ?? '') })),
        sections,
        Number(videoRecord?.script_json?.beat_pause_seconds ?? DEFAULT_BEAT_PAUSE_SEC),
      );

      // Ensure SFX presets exist and resolve active SFX path
      await ensureDefaultSfxPresets().catch(() => {});
      const sfxTrack = (videoRecord?.script_json?.sfx?.track ||
        videoRecord?.sfx_track ||
        'smart') as string;
      const sfxVolume = Number(
        videoRecord?.script_json?.sfx?.volume ?? videoRecord?.sfx_volume ?? 0.25,
      );
      const sfxEnabled =
        videoRecord?.script_json?.sfx?.enabled !== false &&
        videoRecord?.sfx_enabled !== false &&
        sfxTrack !== 'none';
      const sfxPath = sfxEnabled ? await resolveSfxPath(sfxTrack) : null;

      const sceneClipPaths: string[] = [];
      const sceneBeatIndexes: number[] = [];
      // The voice starts this far into each scene (its lead-in)
      const sceneLeadInMs: number[] = [];

      // Generated visuals are produced by the voicing job, while assembly runs as its own job,
      // so the visual-unit fallback searches this job first, then the video's other jobs (newest first).
      const visualSearchJobIds: string[] = [this.jobId];
      if (videoId) {
        const { data: videoJobs } = await this.supabase
          .from('yt_jobs')
          .select('id')
          .eq('video_id', videoId)
          .order('created_at', { ascending: false });
        for (const j of videoJobs ?? []) {
          if (!visualSearchJobIds.includes(j.id)) visualSearchJobIds.push(j.id);
        }
      }

      // 5. Render or reuse each beat scene
      for (let i = 0; i < scriptBeats.length; i++) {
        // Video beats are positional; LLM-generated job scenes are keyed by scene_number,
        // which is what the TTS/visual units were checkpointed under.
        const beatIndex: number =
          !usingVideoBeats && typeof scriptBeats[i]?.scene_number === 'number'
            ? scriptBeats[i].scene_number
            : i;

        // Resolve beat audio and measured duration
        const ttsUnit = ttsMap.get(beatIndex);
        if (!ttsUnit || !ttsUnit.output_path) {
          throw new Error(
            `Missing TTS audio for beat ${beatIndex}. Voice stage must complete first.`,
          );
        }

        const audioPath = ttsUnit.output_path;
        let durationMs = ttsUnit.duration_ms;
        if (!durationMs || durationMs <= 0) {
          durationMs = await getAudioDurationMs(audioPath);
        }

        // Resolve visual asset
        let visualPath: string | null = null;
        let isVideo = false;

        // A. Manual upload in storage/uploads/<videoId>/beat-<i>.<ext>
        if (videoId) {
          const uploaded = await findExistingBeatUpload(videoId, beatIndex);
          if (uploaded) {
            visualPath = uploaded.filePath;
            isVideo = uploaded.isVideo;
          }
        }

        // Fetch video_assets row for fallback visual or trim offsets
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped select('*') row
        let assetRow: any = null;
        if (videoId) {
          const { data: aRow } = await this.supabase
            .from('video_assets')
            .select('*')
            .eq('video_id', videoId)
            .eq('beat_index', beatIndex)
            .maybeSingle();
          assetRow = aRow;
        }

        // B. video_assets provenance record
        if (!visualPath && assetRow?.source_url) {
          const candidatePath = path.isAbsolute(assetRow.source_url)
            ? assetRow.source_url
            : path.join(process.cwd(), assetRow.source_url);
          const exists = await fs
            .stat(candidatePath)
            .then((s) => s.isFile())
            .catch(() => false);
          if (exists) {
            visualPath = candidatePath;
            const ext = path.extname(candidatePath).toLowerCase().replace('.', '');
            isVideo = ['mp4', 'mov', 'webm'].includes(ext);
          }
        }

        // C. Generated visuals / legacy image units, from this job or an earlier job for the video
        for (const searchJobId of visualSearchJobIds) {
          if (visualPath) break;
          const { data: visualUnits } = await this.supabase
            .from('yt_job_units')
            .select('output_path, stage')
            .eq('job_id', searchJobId)
            .in('stage', ['image', 'visuals'])
            .eq('unit_index', beatIndex)
            .eq('status', 'done');

          for (const unit of visualUnits ?? []) {
            if (!unit.output_path) continue;
            const onDisk = await fs
              .stat(unit.output_path)
              .then((s) => s.isFile() && s.size > 0)
              .catch(() => false);
            if (onDisk) {
              visualPath = unit.output_path;
              const unitExt = path.extname(unit.output_path).toLowerCase().replace('.', '');
              isVideo = ['mp4', 'mov', 'webm'].includes(unitExt);
              break;
            }
          }
        }

        if (!visualPath) {
          throw new Error(`No visual asset found for beat ${beatIndex}`);
        }

        const startOffsetSeconds = Number(
          assetRow?.start_offset_seconds ??
          videoRecord?.script_json?.beats?.[beatIndex]?.start_offset_seconds ??
          videoRecord?.script_json?.trim_offsets?.[beatIndex]?.start_offset_seconds ??
          0,
        );

        const stillMotion = (videoRecord?.script_json?.still_motion ||
          videoRecord?.still_motion ||
          'zoom') as 'zoom' | 'static';

        const padStyle = (videoRecord?.script_json?.pad_style ||
          videoRecord?.pad_style ||
          'blur') as 'blur' | 'black';

        const transition = (videoRecord?.script_json?.transition ||
          videoRecord?.transition ||
          'cut') as 'cut' | 'dip_black' | 'dip_white' | 'crossfade' | 'wipe' | 'style';

        const beatPacing = pacingPlan.get(beatIndex) ?? { leadInSec: 0, tailSec: DEFAULT_BEAT_PAUSE_SEC, dipIn: false, dipOut: false };
        const beatPauseSeconds = beatPacing.tailSec;
        // A composed track has its own lead-in built in (none if composed before pacing existed);
        // the voice must start where the track's cuts expect it
        let leadInSeconds = beatPacing.leadInSec;
        if (assetRow?.visual_type === 'composite') {
          leadInSeconds = (await readSidecar(visualPath))?.leadInSec ?? 0;
        }

        const visualStat = await fs.stat(visualPath).catch(() => null);
        const visualFingerprint = visualStat
          ? `${Math.round(visualStat.mtimeMs)}-${visualStat.size}`
          : visualPath;

        const audioStat = await fs.stat(audioPath).catch(() => null);
        const audioFingerprint = audioStat
          ? `${Math.round(audioStat.mtimeMs)}-${audioStat.size}`
          : audioPath;

        const sceneClipPath = path.join(tempDir, `scene_${beatIndex}.mp4`);
        const inputHash = computeInputHash({
          stage: 'assembly',
          input: {
            beatIndex,
            visualPath,
            visualFingerprint,
            isVideo,
            shortVideoBehavior: 'hold',
            audioPath,
            audioFingerprint,
            durationMs,
            padStyle,
            startOffsetSeconds,
            stillMotion,
            transition,
            sfxTrack: sfxEnabled ? sfxTrack : 'none',
            sfxVolume,
            beatPauseSeconds,
            leadInSeconds,
            // Style-matched transitions mark chapter changes themselves, so the clips don't dip
            dipIn: transition === 'style' ? false : beatPacing.dipIn,
            dipOut: transition === 'style' ? false : beatPacing.dipOut,
            // Bumped when scene rendering changes, so clips from an older chain aren't reused
            sceneChain: 'v2-voice-chain',
          },
          providerId: 'ffmpeg',
        });

        // 5a. Current job checkpoint check: only reuse if input_hash matches perfectly
        const { data: existingUnit } = await this.supabase
          .from('yt_job_units')
          .select('*')
          .eq('job_id', this.jobId)
          .eq('stage', 'assembly')
          .eq('unit_index', beatIndex)
          .maybeSingle();

        if (
          existingUnit &&
          existingUnit.status === 'done' &&
          existingUnit.output_path &&
          existingUnit.input_hash === inputHash
        ) {
          const exists = await fs
            .stat(existingUnit.output_path)
            .then((s) => s.isFile() && s.size > 0)
            .catch(() => false);

          if (exists) {
            console.log(`[Assembly] Beat ${beatIndex}: Resuming existing unit checkpoint (${existingUnit.output_path})`);
            sceneClipPaths.push(existingUnit.output_path);
            sceneBeatIndexes.push(beatIndex);
            sceneLeadInMs.push(Math.round(leadInSeconds * 1000));
            continue;
          }
        }

        // 5b. Smart Incremental Re-assembly:
        // Check if an existing scene clip with identical inputs already exists on disk from prior jobs
        let reusableClipPath: string | null = null;
        if (videoId) {
          const { data: cachedUnits } = await this.supabase
            .from('yt_job_units')
            .select('output_path')
            .eq('stage', 'assembly')
            .eq('unit_index', beatIndex)
            .eq('status', 'done')
            .eq('input_hash', inputHash)
            .order('updated_at', { ascending: false })
            .limit(1);

          if (cachedUnits && cachedUnits[0]?.output_path) {
            const exists = await fs
              .stat(cachedUnits[0].output_path)
              .then((s) => s.isFile() && s.size > 0)
              .catch(() => false);
            if (exists) {
              reusableClipPath = cachedUnits[0].output_path;
            }
          }
        }

        if (reusableClipPath) {
          console.log(`[Assembly] Beat ${beatIndex}: Reusing cached scene clip (${reusableClipPath})`);
          // Reused! Record unit as done and skip FFmpeg scene rendering
          await this.supabase.from('yt_job_units').upsert(
            {
              job_id: this.jobId,
              stage: 'assembly',
              unit_index: beatIndex,
              status: 'done',
              input_hash: inputHash,
              output_path: reusableClipPath,
              duration_ms: durationMs,
              attempts: 1,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'job_id,stage,unit_index' },
          );
          sceneClipPaths.push(reusableClipPath);
          sceneBeatIndexes.push(beatIndex);
          sceneLeadInMs.push(Math.round(leadInSeconds * 1000));
          continue;
        }

        console.log(`[Assembly] Beat ${beatIndex}: Rendering fresh scene clip (isVideo=${isVideo}, stillMotion=${stillMotion}, visual=${visualPath})`);

        // Checkpoint as running
        await this.supabase.from('yt_job_units').upsert(
          {
            job_id: this.jobId,
            stage: 'assembly',
            unit_index: beatIndex,
            status: 'running',
            input_hash: inputHash,
            attempts: (existingUnit?.attempts ?? 0) + 1,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'job_id,stage,unit_index' },
        );


        try {
          await renderBeatScene({
            visualPath,
            audioPath,
            durationMs,
            outputPath: sceneClipPath,
            isVideo,
            shortVideoBehavior: 'hold',
            stillMotion,
            padStyle,
            startOffsetSeconds,
            transition,
            sfxPath,
            sfxVolume,
            pauseSeconds: beatPauseSeconds,
            leadInSeconds,
            dipIn: transition === 'style' ? false : beatPacing.dipIn,
            dipOut: transition === 'style' ? false : beatPacing.dipOut,
          });

          // Checkpoint as done
          await this.supabase
            .from('yt_job_units')
            .update({
              status: 'done',
              output_path: sceneClipPath,
              duration_ms: durationMs,
              error: null,
              updated_at: new Date().toISOString(),
            })
            .eq('job_id', this.jobId)
            .eq('stage', 'assembly')
            .eq('unit_index', beatIndex);

          sceneClipPaths.push(sceneClipPath);
          sceneBeatIndexes.push(beatIndex);
          sceneLeadInMs.push(Math.round(leadInSeconds * 1000));
        } catch (beatErr) {
          const beatErrMsg = beatErr instanceof Error ? beatErr.message : String(beatErr);
          await this.supabase
            .from('yt_job_units')
            .update({
              status: 'failed',
              error: beatErrMsg,
              updated_at: new Date().toISOString(),
            })
            .eq('job_id', this.jobId)
            .eq('stage', 'assembly')
            .eq('unit_index', beatIndex);

          if (videoId) {
            await this.supabase
              .from('videos')
              .update({
                status: 'failed',
                error_message: `Assembly failed on beat ${beatIndex}: ${beatErrMsg}`,
              })
              .eq('id', videoId);
          }

          throw beatErr;
        }
      }

      // 6. Concatenate all scenes into final video
      const transition = (videoRecord?.script_json?.transition ||
        videoRecord?.transition ||
        'cut') as 'cut' | 'dip_black' | 'dip_white' | 'crossfade' | 'wipe' | 'style';
      // The joined beats are a working file; mastering writes the delivery file at the end
      let programPath = path.join(tempDir, `program_${Date.now()}.mp4`);
      const workingFiles: string[] = [programPath];
      // Style-matched: a transition per join, sized to the moment and to the silence there
      const reveals = new Set<number>(Array.isArray(videoRecord?.script_json?.music_moments?.reveals) ? videoRecord.script_json.music_moments.reveals : []);
      const joins =
        transition === 'style'
          ? planTransitions(
              sceneBeatIndexes.slice(1).map((next, i) => {
                const prev = pacingPlan.get(sceneBeatIndexes[i]);
                const nextPacing = pacingPlan.get(next);
                return {
                  chapter: nextPacing?.dipIn ?? false,
                  reveal: reveals.has(next),
                  silenceSec: (prev?.tailSec ?? DEFAULT_BEAT_PAUSE_SEC) + (nextPacing?.leadInSec ?? 0),
                };
              }),
              videoRecord?.style,
              (videoRecord?.script_json?.transition_intensity as TransitionIntensity | undefined) ?? 'balanced',
              // Film burn, ink, paper tear, glitch... at chapter changes and reveals (slow to render)
              { rendered: videoRecord?.script_json?.transition_rendered !== false },
            )
          : undefined;
      const joined = await joinSceneClips(sceneClipPaths, programPath, tempDir, {
        transition,
        joins,
      });
      if (joins) {
        const moves = joins.filter((j) => j.type !== 'cut');
        console.log(`[Assembly] Transitions: ${moves.length} of ${joins.length} joins (${[...new Set(moves.map((j) => j.type))].join(', ') || 'all cuts'})`);
      }

      // Where each beat really starts in the finished video (captions, chapters and sound use it).
      // Timed from how the beats were actually joined: a crossfade that fell back to cuts must
      // not leave the captions running ahead by half a second per beat.
      const clipDurationsSec = await Promise.all(sceneClipPaths.map((p) => probeClipDurationSec(p)));
      const beatStartMs = (
        joined.overlapsSec.length === clipDurationsSec.length - 1
          ? startsFromOverlaps(clipDurationsSec, joined.overlapsSec)
          : computeSceneStartOffsetsSec(clipDurationsSec, joined.overlapSec > 0 ? (transition === 'style' ? 'cut' : transition) : 'cut')
      ).map((s) => Math.round(s * 1000));

      // Composed beats' shot lists say what is on screen when (captions and sound design use it)
      const { data: composedRows } = videoId
        ? await this.supabase.from('video_assets').select('beat_index, source_url').eq('video_id', videoId).eq('visual_type', 'composite')
        : { data: [] as Array<{ beat_index: number; source_url: string | null }> };
      const trackByBeat = new Map(
        (composedRows ?? [])
          .filter((r) => r.source_url)
          .map((r) => [r.beat_index, path.isAbsolute(r.source_url!) ? r.source_url! : path.join(process.cwd(), r.source_url!)]),
      );

      // 6a. Kinetic captions if a preset is selected (off by default), burned in at mastering
      let assPath: string | null = null;
      const captionPreset = videoRecord?.script_json?.captions?.preset;
      if (isCaptionPreset(captionPreset)) {
        assPath = path.join(tempDir, 'captions.ass');
        const captionBeats = sceneBeatIndexes.map((beatIndex, pos) => ({
          index: beatIndex,
          text: String(scriptBeats[pos]?.text ?? scriptBeats[pos]?.narration ?? ''),
          audioPath: ttsMap.get(beatIndex)?.output_path,
        }));
        await writeAssCaptionsFile(
          {
            beats: captionBeats,
            units: Array.from(ttsMap.values()),
            preset: captionPreset,
            // Each beat's voice starts after its lead-in
            beatStartMs: beatStartMs.map((ms, pos) => ms + (sceneLeadInMs[pos] ?? 0)),
            words: await loadCaptionWords(captionBeats),
            highlightHex: themeForStyle(videoRecord?.style).accent,
            zones: await captionZonesFromTracks(
              sceneBeatIndexes.map((b, pos) => ({ sceneStartMs: beatStartMs[pos], trackPath: trackByBeat.get(b) ?? null })),
            ),
          },
          assPath,
        );
      }

      // Credit lines the music needs in the video description
      let musicCreditLines: string[] = [];

      // 6b. Apply background music with auto-ducking if configured
      const bgmEnabled =
        videoRecord?.bgm_enabled !== false &&
        videoRecord?.script_json?.bgm?.enabled !== false;
      const bgmTrack =
        videoRecord?.bgm_track || videoRecord?.script_json?.bgm?.track || 'story';
      const bgmVolume = Number(
        videoRecord?.bgm_volume ?? videoRecord?.script_json?.bgm?.volume ?? 0.2,
      );
      const bgmCustomUrl =
        videoRecord?.bgm_custom_url || videoRecord?.script_json?.bgm?.customUrl;

      if (bgmEnabled && bgmTrack !== 'none') {
        // "story": music chosen per section from the mood library, crossfading where the story turns
        let bgmTrackPath: string | null = null;
        if (bgmTrack === 'story' && videoId && usingVideoBeats && sections.length > 0) {
          try {
            const totalMs = beatStartMs.length
              ? beatStartMs[beatStartMs.length - 1] + Math.round(clipDurationsSec[clipDurationsSec.length - 1] * 1000)
              : 0;
            const startOf = (beat: number) => beatStartMs[sceneBeatIndexes.indexOf(beat)] ?? 0;
            const moods = await ensureMusicPlan({
              supabase: this.supabase,
              videoId,
              scriptJson: videoRecord.script_json,
              sections,
              style: videoRecord?.style,
              topic: videoRecord?.topic,
              llm: await resolveForStage<LLMProvider>('script', this.supabase).catch(() => null),
            });
            const segments = await pickMusic(
              sections.map((s, i) => ({
                startMs: i === 0 ? 0 : startOf(s.start_beat),
                endMs: sections[i + 1] ? startOf(sections[i + 1].start_beat) : totalMs,
                mood: moods[i] ?? 'mysterious',
              })),
            );
            if (segments) {
              bgmTrackPath = path.join(tempDir, `music_bed_${Date.now()}.m4a`);
              workingFiles.push(bgmTrackPath);
              await buildMusicBed(segments, bgmTrackPath);
              musicCreditLines = musicCredits(segments);
              console.log(`[Assembly] Music: ${segments.map((s) => `${s.mood} "${s.track.title}"`).join(' → ')}`);
            }
          } catch (musicErr) {
            console.warn('[Assembly] Story music failed; continuing without music:', musicErr);
          }
        } else {
          bgmTrackPath = await resolveBgmTrackPath({
            track: bgmTrack,
            customUrl: bgmCustomUrl,
            videoId,
          });
        }

        if (bgmTrackPath) {
          // Music that hits moments: swells into reveals, silence before key lines, stings at chapter changes
          let accentExpr: string | undefined;
          let sting: { path: string; atSec: number[] } | undefined;
          if (videoId && videoRecord?.script_json?.bgm?.accents !== false) {
            try {
              const beatsForMusic = sceneBeatIndexes.map((beatIndex, pos) => ({
                index: beatIndex,
                text: String(scriptBeats[pos]?.text ?? scriptBeats[pos]?.narration ?? ''),
              }));
              const plan = await ensureMusicMoments(this.supabase, videoId, beatsForMusic.filter((b) => b.text.trim()));
              const voices = Object.fromEntries(
                sceneBeatIndexes.map((beatIndex, pos) => {
                  const start = beatStartMs[pos] + (sceneLeadInMs[pos] ?? 0);
                  return [beatIndex, { startMs: start, endMs: start + (ttsMap.get(beatIndex)?.duration_ms ?? 0) }];
                }),
              );
              const chapterChangesMs = sections
                .slice(1)
                .map((s) => beatStartMs[sceneBeatIndexes.indexOf(s.start_beat)])
                .filter((ms): ms is number => typeof ms === 'number' && ms > 0);
              const accents = accentTimes(plan, voices, chapterChangesMs);
              accentExpr = accentExpression(accents);
              if (accents.stingsSec.length) sting = { path: await stingPath(), atSec: accents.stingsSec };
              console.log(
                `[Assembly] Music accents: ${accents.swellsSec.length} swell(s), ${accents.drops.length} silence(s), ${accents.stingsSec.length} sting(s)`,
              );
            } catch (accentErr) {
              console.warn('[Assembly] Music accents skipped:', accentErr instanceof Error ? accentErr.message.slice(0, 200) : accentErr);
            }
          }
          const withMusicPath = path.join(tempDir, `program_music_${Date.now()}.mp4`);
          workingFiles.push(withMusicPath);
          await applyBackgroundMusic({
            videoPath: programPath,
            bgmPath: bgmTrackPath,
            outputPath: withMusicPath,
            volume: bgmVolume,
            accentExpression: accentExpr,
            sting,
          });
          programPath = withMusicPath;
        }
      }

      // Narration sound cues, kept for emphasis (impact sounds get a camera shake)
      let narrationCuesForEmphasis: Array<{ atMs: number; sound: string }> = [];

      // 6b+. Smart sound design: effects placed by what's on screen, laid over voice and music
      // (after the music, so the music ducks for the voice only)
      if (sfxEnabled && sfxTrack === 'smart') {
        const shotCuesPlanned = await planSoundCues(
          sceneBeatIndexes.map((b, pos) => ({
            sceneStartMs: beatStartMs[pos],
            trackPath: trackByBeat.get(b) ?? null,
            opensSection: pacingPlan.get(b)?.dipIn ?? false,
          })),
        );
        // Real sounds on the words that describe them ("fires two shots") and ambience beds; never blocks assembly
        const narrationPlanned =
          !videoId || videoRecord?.script_json?.sfx?.narration === false
            ? { cues: [], beds: [] }
            : await narrationSoundCues({
                supabase: this.supabase,
                videoId,
                style: videoRecord?.style,
                beats: sceneBeatIndexes.map((beatIndex, pos) => ({
                  index: beatIndex,
                  text: String(scriptBeats[pos]?.text ?? scriptBeats[pos]?.narration ?? ''),
                  audioPath: ttsMap.get(beatIndex)?.output_path,
                  voiceStartMs: beatStartMs[pos] + (sceneLeadInMs[pos] ?? 0),
                  sceneStartMs: beatStartMs[pos],
                  sceneEndMs: beatStartMs[pos] + Math.round((clipDurationsSec[pos] ?? 0) * 1000),
                })),
              }).catch((err) => {
                console.warn('[Assembly] Narration sounds skipped:', err instanceof Error ? err.message.slice(0, 200) : err);
                return { cues: [], beds: [] };
              });
        narrationCuesForEmphasis = narrationPlanned.cues;
        // The style's real recordings for on-screen effects, where available
        const shotCuesVoiced =
          videoRecord?.script_json?.sfx?.palette === false
            ? shotCuesPlanned
            : await applyPalette(shotCuesPlanned, videoRecord?.style).catch(() => shotCuesPlanned);
        const cues = [...shotCuesVoiced, ...narrationPlanned.cues].sort((a, b) => a.atMs - b.atMs);
        if (cues.length > 0 || narrationPlanned.beds.length > 0) {
          const withSfxPath = path.join(tempDir, `program_sfx_${Date.now()}.mp4`);
          workingFiles.push(withSfxPath);
          await applySoundDesign({ videoPath: programPath, outputPath: withSfxPath, cues, beds: narrationPlanned.beds, volume: sfxVolume });
          programPath = withSfxPath;
          const real = shotCuesVoiced.filter((c) => c.file).length;
          console.log(
            `[Assembly] Sound design: ${cues.length} effects placed (${narrationPlanned.cues.length} on the narration, ${real} real recordings for on-screen effects), ${narrationPlanned.beds.length} ambience bed(s)`,
          );
        }
      }

      // 6c. Master: the style's look, captions, loudness to YouTube's reference and the end fade,
      // with one picture encode
      const grade = lookFilter(themeForStyle(videoRecord?.style).name, videoRecord?.script_json?.look);
      // Emphasis: shakes on impacts, freeze-frames with titles, chapter zooms, letterbox
      const emphasis =
        videoId && usingVideoBeats
          ? await prepareEmphasis({
              supabase: this.supabase,
              videoId,
              style: videoRecord?.style,
              theme: themeForStyle(videoRecord?.style),
              beats: sceneBeatIndexes.map((beatIndex, pos) => {
                const start = beatStartMs[pos] + (sceneLeadInMs[pos] ?? 0);
                return {
                  index: beatIndex,
                  text: String(scriptBeats[pos]?.text ?? scriptBeats[pos]?.narration ?? ''),
                  voiceStartMs: start,
                  voiceEndMs: start + (ttsMap.get(beatIndex)?.duration_ms ?? 0),
                };
              }),
              soundCues: narrationCuesForEmphasis,
              chapterChangesMs: sections
                .slice(1)
                .map((s) => beatStartMs[sceneBeatIndexes.indexOf(s.start_beat)])
                .filter((ms): ms is number => typeof ms === 'number' && ms > 0),
              settings: videoRecord?.script_json?.emphasis,
              tempDir,
            }).catch((err) => {
              console.warn('[Assembly] Emphasis effects skipped:', err instanceof Error ? err.message.slice(0, 200) : err);
              return null;
            })
          : null;
      if (emphasis) console.log(`[Assembly] Emphasis: ${emphasis.summary}`);
      try {
        try {
          const { measured } = await masterFinalVideo({ inputPath: programPath, outputPath: finalRenderPath, assPath, lookFilter: grade, emphasis });
          console.log(
            `[Assembly] Mastered to ${TARGET_LUFS} LUFS (programme measured ${measured.input_i} LUFS)` +
              `${grade ? `, ${themeForStyle(videoRecord?.style).name} look` : ''}${assPath ? `, "${captionPreset}" captions` : ''}`,
          );
        } catch (masterErr) {
          // Emphasis is the newest part of the graph: drop it first, keeping the look and captions
          const retried = emphasis
            ? await masterFinalVideo({ inputPath: programPath, outputPath: finalRenderPath, assPath, lookFilter: grade })
                .then(() => true)
                .catch(() => false)
            : false;
          if (retried) {
            console.warn('[Assembly] Mastering with emphasis effects failed; mastered without them:', masterErr instanceof Error ? masterErr.message.slice(0, 300) : masterErr);
          } else {
            if (!assPath && !grade) throw masterErr;
            // Keep a plain master rather than failing the whole assembly
            console.warn('[Assembly] Mastering with look/captions failed; mastering without them:', masterErr);
            await masterFinalVideo({ inputPath: programPath, outputPath: finalRenderPath });
          }
        }
      } finally {
        for (const f of workingFiles) await fs.unlink(f).catch(() => {});
      }

      // 6d. Final quality check: black frames, frozen picture, dead air, loudness, format, sync
      let qualityReport: QualityReport | null = null;
      try {
        const editLengthMs = beatStartMs.length
          ? beatStartMs[beatStartMs.length - 1] + Math.round(clipDurationsSec[clipDurationsSec.length - 1] * 1000)
          : 0;
        qualityReport = await runFinalQualityCheck(finalRenderPath, {
          // Section changes are where the intended dips to black are
          sectionChangesSec: sections
            .slice(1)
            .map((s) => beatStartMs[sceneBeatIndexes.indexOf(s.start_beat)])
            .filter((ms): ms is number => typeof ms === 'number')
            .map((ms) => ms / 1000),
          expectedDurationSec: editLengthMs ? editLengthMs / 1000 : undefined,
        });
        const issues = qualityReport.checks.filter((c) => c.status !== 'pass');
        console.log(
          `[Assembly] Quality check ${qualityReport.passed ? 'passed' : 'FAILED'}` +
            (issues.length ? `: ${issues.map((c) => `${c.status} ${c.label} (${c.detail})`).join('; ')}` : ''),
        );
      } catch (qcErr) {
        console.warn('[Assembly] Quality check could not run:', qcErr);
      }

      // Also ensure baseOutputDir has a copy if finalRenderPath is in storage/renders
      const jobFinalVideo = path.join(this.baseOutputDir, 'final_video.mp4');
      if (finalRenderPath !== jobFinalVideo) {
        await fs.mkdir(this.baseOutputDir, { recursive: true });
        await fs.copyFile(finalRenderPath, jobFinalVideo).catch(() => {});
      }

      await this.updateStageStatus('assembly', 'done');

      // 7. Update videos status, render_url, and final chapters
      if (videoId) {
        let updatedScriptJson = videoRecord?.script_json;

        // Title options, description, tags and hashtags for publishing (regenerated on the publish page)
        let publishMetadata: VideoMetadata | null = videoRecord?.script_json?.publish?.metadata ?? null;
        if (usingVideoBeats) {
          try {
            const scriptLlm = await resolveForStage<LLMProvider>('script', this.supabase);
            publishMetadata = await generateMetadata({
              topic: videoRecord?.topic ?? '',
              style: videoRecord?.style,
              currentTitle: videoRecord?.title,
              narration: scriptBeats.map((b) => String(b.text ?? '')),
              sectionTitles: sections.map((s) => s.title),
              facts: (videoRecord?.script_json?.research?.facts ?? []).map((f: { claim: string }) => f.claim),
              llm: scriptLlm.provider,
              ctx: withWritingModel(scriptLlm.ctx, scriptLlm.options),
            });
          } catch (metaErr) {
            console.warn('[Assembly] Publishing metadata could not be generated (regenerate on the publish page):', metaErr);
          }
        }

        // Where everything is in the finished video (subtitles, thumbnails and Shorts use it)
        const videoTimeline: VideoTimeline = {
          version: 1,
          renderedAt: new Date().toISOString(),
          totalMs: beatStartMs.length
            ? beatStartMs[beatStartMs.length - 1] + Math.round(clipDurationsSec[clipDurationsSec.length - 1] * 1000)
            : 0,
          beats: sceneBeatIndexes.map((b, pos) => ({
            index: b,
            sceneStartMs: beatStartMs[pos],
            sceneMs: Math.round(clipDurationsSec[pos] * 1000),
            voiceStartMs: beatStartMs[pos] + (sceneLeadInMs[pos] ?? 0),
            voiceMs: ttsMap.get(b)?.duration_ms ?? null,
            audioPath: ttsMap.get(b)?.output_path ?? null,
            trackPath: trackByBeat.get(b) ?? null,
          })),
        };

        // Thumbnails from the video's own strongest frames (regenerated on the publish page)
        let publishThumbnails: Thumbnail[] | null = videoRecord?.script_json?.publish?.thumbnails ?? null;
        if (usingVideoBeats && videoTimeline.beats.length) {
          try {
            publishThumbnails = await generateThumbnails({
              videoId,
              timeline: videoTimeline,
              finalVideoPath: finalRenderPath,
              title: publishMetadata?.titles[0]?.text ?? videoRecord?.title ?? videoRecord?.topic ?? '',
              topic: videoRecord?.topic ?? '',
              narration: scriptBeats.map((b) => String(b.text ?? '')).join(' '),
              theme: themeForStyle(videoRecord?.style),
              llm: await resolveForStage<LLMProvider>('script', this.supabase).catch(() => null),
            });
            console.log(`[Assembly] Thumbnails: ${publishThumbnails.map((t) => `"${t.text}"`).join(', ')}`);
          } catch (thumbErr) {
            console.warn('[Assembly] Thumbnails could not be generated (regenerate on the publish page):', thumbErr);
          }
        }

        if (scriptBeats && scriptBeats.length > 0) {
          try {
            const chapterResult = generateYouTubeChapters({
              beats: scriptBeats.map((b, idx) => ({
                index: typeof b.index === 'number' ? b.index : typeof b.scene_number === 'number' ? b.scene_number : idx,
                text: b.text || b.narration,
                title: b.title,
                chapter_title: b.chapter_title,
                duration_estimate_seconds: b.duration_estimate_seconds,
              })),
              units: ttsUnits,
              customTitles: videoRecord?.script_json?.custom_chapters || {},
              sections,
              beatStartMs: Object.fromEntries(sceneBeatIndexes.map((b, pos) => [b, beatStartMs[pos]])),
            });

            updatedScriptJson = {
              ...(videoRecord?.script_json || {}),
              chapters: chapterResult.chapters,
              formatted_chapters: chapterResult.formattedText,
              music_credits: musicCreditLines,
              timeline: videoTimeline,
              quality_report: qualityReport,
              publish: { ...(videoRecord?.script_json?.publish ?? {}), metadata: publishMetadata, thumbnails: publishThumbnails },
            };
          } catch (chapErr) {
            console.warn('[JobRunner] Failed to generate chapters on assembly finish:', chapErr);
          }
        }

        await this.supabase
          .from('videos')
          .update({
            status: 'rendered',
            render_url: `/api/videos/${videoId}/render`,
            script_json: updatedScriptJson,
            error_message: null,
          })
          .eq('id', videoId);
      }

      return finalRenderPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.updateStageStatus('assembly', 'failed', msg);
      if (videoId) {
        await this.supabase
          .from('videos')
          .update({
            status: 'failed',
            error_message: msg,
          })
          .eq('id', videoId);
      }
      throw err;
    }
  }

  async runThumbnailStage(): Promise<string> {
    if (await this.isStageDone('thumbnail')) {
      return path.join(this.baseOutputDir, 'thumbnail.png');
    }

    await this.updateStageStatus('thumbnail', 'running');
    try {
      const job = await this.getJob();
      const { provider, ctx, maxRetries, configId, providerId, model, options } =
        await resolveForStage<ImageProvider>('thumbnail', this.supabase);

      const prompt = `Eye-catching, high-contrast, viral YouTube video thumbnail art for: "${job.topic}". High resolution, vivid details, bold composition.`;
      const outputDir = this.baseOutputDir;

      const result = await runJobUnit({
        jobId: this.jobId,
        stage: 'thumbnail',
        unitIndex: 0,
        input: { prompt, width: 1792, height: 1024 },
        providerConfigId: configId,
        providerId,
        model,
        baseUrl: ctx.baseUrl,
        options,
        maxRetries,
        supabase: this.supabase,
        outputDir,
        signal: this.signal,
        execute: async () => {
          return await provider.generate(
            { prompt, width: 1792, height: 1024 },
            ctx,
          );
        },
      });

      if (!result.success || !result.outputPath) {
        throw new Error(result.error || 'Failed generating thumbnail');
      }

      await this.updateStageStatus('thumbnail', 'done');
      return result.outputPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.updateStageStatus('thumbnail', 'failed', msg);
      throw err;
    }
  }

  async runMetadataStage(): Promise<{ title: string; description: string; tags: string[] }> {
    if (await this.isStageDone('metadata')) {
      return { title: '', description: '', tags: [] };
    }

    await this.updateStageStatus('metadata', 'running');
    try {
      const job = await this.getJob();
      const { provider, ctx } = await resolveForStage<LLMProvider>('metadata', this.supabase);

      const prompt = `Generate optimized YouTube metadata for a video titled/about:\nTopic: ${job.topic}\nProvide a click-worthy title, detailed description with hashtags and chapters, and relevant SEO tags.`;

      const response = await provider.generateJson(
        {
          system: 'You are an SEO and YouTube growth specialist.',
          prompt,
          schema: MetadataSchema,
        },
        ctx,
      );

      await this.updateStageStatus('metadata', 'done');
      return response.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.updateStageStatus('metadata', 'failed', msg);
      throw err;
    }
  }
}
