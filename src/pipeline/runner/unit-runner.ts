import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeInputHash } from '../utils/hash';
import { getRetryDecision, ProviderError } from '../providers/errors';
import { getAudioDurationMs } from '../utils/ffmpeg';
import type { Usage } from '../providers/types';

export interface RunUnitOptions<TInput = unknown> {
  jobId: string;
  stage: 'image' | 'visuals' | 'tts' | 'assembly' | 'thumbnail';
  unitIndex: number;
  input: TInput;
  providerConfigId?: string | null;
  providerId: string;
  model?: string | null;
  baseUrl?: string | null;
  options?: Record<string, unknown>;
  maxRetries?: number;
  supabase: SupabaseClient;
  outputDir: string;
  execute: (signal?: AbortSignal) => Promise<{
    bytes?: Uint8Array;
    outputPath?: string;
    mimeType?: string;
    durationMs?: number;
    usage?: Usage;
  }>;
  checkFileExists?: (filePath: string) => Promise<boolean>;
  measureDuration?: (filePath: string) => Promise<number>;
  signal?: AbortSignal;
}

export interface UnitRunResult {
  skipped: boolean;
  success: boolean;
  outputPath?: string;
  durationMs?: number;
  costUsd?: number;
  error?: string;
}

export async function defaultCheckFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function getExtensionForMimeType(mimeType?: string, stage?: string): string {
  if (mimeType) {
    if (mimeType.includes('png')) return 'png';
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
    if (mimeType.includes('webp')) return 'webp';
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
    if (mimeType.includes('mp4')) return 'mp4';
    if (mimeType.includes('webm')) return 'webm';
  }
  if (stage === 'image' || stage === 'thumbnail') return 'png';
  if (stage === 'visuals') return 'mp4';
  if (stage === 'tts') return 'mp3';
  if (stage === 'assembly') return 'mp4';
  return 'bin';
}

/**
 * Executes a single job unit with input hashing, checkpoint checking,
 * automatic skip on cache match, retry policy, and post-processing separation.
 */
export async function runJobUnit<TInput = unknown>(
  options: RunUnitOptions<TInput>,
): Promise<UnitRunResult> {
  const {
    jobId,
    stage,
    unitIndex,
    input,
    providerConfigId,
    providerId,
    model,
    baseUrl,
    options: providerOptions = {},
    maxRetries = 1,
    supabase,
    outputDir,
    execute,
    checkFileExists = defaultCheckFileExists,
    measureDuration = getAudioDurationMs,
    signal,
  } = options;

  // 1. Compute input_hash = sha256(stableStringify({ stage, input, providerId, model, baseUrl, options }))
  const inputHash = computeInputHash({
    stage,
    input,
    providerId,
    model,
    baseUrl,
    options: providerOptions,
  });

  // 2. Load existing unit row
  const { data: existingUnit, error: fetchError } = await supabase
    .from('yt_job_units')
    .select('*')
    .eq('job_id', jobId)
    .eq('stage', stage)
    .eq('unit_index', unitIndex)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to query unit row: ${fetchError.message}`);
  }

  // Check if already done and valid cache
  if (
    existingUnit &&
    existingUnit.status === 'done' &&
    existingUnit.input_hash === inputHash &&
    existingUnit.output_path
  ) {
    const fileExists = await checkFileExists(existingUnit.output_path);
    if (fileExists) {
      return {
        skipped: true,
        success: true,
        outputPath: existingUnit.output_path,
        durationMs: existingUnit.duration_ms,
        costUsd: existingUnit.cost_usd ? Number(existingUnit.cost_usd) : undefined,
      };
    }
  }

  let attempts = (existingUnit?.attempts ?? 0) + 1;

  // 3. Upsert the row as running, increment attempts, reset stale values on rerun
  const { error: upsertError } = await supabase.from('yt_job_units').upsert(
    {
      job_id: jobId,
      stage,
      unit_index: unitIndex,
      status: 'running',
      input_hash: inputHash,
      provider_config_id: providerConfigId ?? null,
      model: model ?? null,
      output_path: null,
      duration_ms: null,
      cost_usd: null,
      attempts,
      error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'job_id,stage,unit_index' },
  );

  if (upsertError) {
    throw new Error(`Failed to update unit to running: ${upsertError.message}`);
  }

  await fs.mkdir(outputDir, { recursive: true });

  // 4. Retry loop: wraps ONLY the provider execute() call
  let currentAttempt = 1;
  let lastExecuteError: unknown;
  let providerResult: Awaited<ReturnType<typeof execute>> | undefined;

  while (currentAttempt <= maxRetries + 1) {
    try {
      if (signal?.aborted) {
        throw new ProviderError('Unit execution aborted', { code: 'aborted' });
      }

      providerResult = await execute(signal);
      break;
    } catch (err) {
      lastExecuteError = err;
      const decision = getRetryDecision(err, currentAttempt, maxRetries);

      if (decision.retry && currentAttempt <= maxRetries) {
        currentAttempt++;
        attempts++;
        if (decision.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
        }
        continue;
      }
      break;
    }
  }

  // If execute() failed
  if (!providerResult) {
    const errorMessage =
      lastExecuteError instanceof Error ? lastExecuteError.message : String(lastExecuteError);

    const { error: failUpdateError } = await supabase
      .from('yt_job_units')
      .update({
        status: 'failed',
        attempts,
        error: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq('job_id', jobId)
      .eq('stage', stage)
      .eq('unit_index', unitIndex);

    if (failUpdateError) {
      console.error(
        `[UnitRunner] Loud failure: Failed to update unit to failed (job: ${jobId}, stage: ${stage}, unit: ${unitIndex}): ${failUpdateError.message}`,
      );
    }

    return {
      skipped: false,
      success: false,
      error: errorMessage,
    };
  }

  // 5. Post-processing outside retry loop: file write, ffprobe, DB update
  let finalPath = providerResult.outputPath;

  try {
    // Save bytes if returned
    if (providerResult.bytes) {
      const ext = getExtensionForMimeType(providerResult.mimeType, stage);
      const fileName = `${stage}_scene_${unitIndex}.${ext}`;
      finalPath = path.join(outputDir, fileName);
      await fs.writeFile(finalPath, providerResult.bytes);
    }

    if (!finalPath) {
      throw new Error('Execution produced neither bytes nor outputPath');
    }

    // If duration is missing and stage is tts or visuals, measure with ffprobe
    let durationMs = providerResult.durationMs;
    if ((stage === 'tts' || stage === 'visuals') && (durationMs === undefined || durationMs === null)) {
      durationMs = await measureDuration(finalPath);
    }

    const costUsd = providerResult.usage?.costUsd;

    // Update unit to 'done'
    const { error: doneUpdateError } = await supabase
      .from('yt_job_units')
      .update({
        status: 'done',
        output_path: finalPath,
        duration_ms: durationMs ?? null,
        cost_usd: costUsd ?? null,
        attempts,
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('job_id', jobId)
      .eq('stage', stage)
      .eq('unit_index', unitIndex);

    if (doneUpdateError) {
      const dbErr = `Provider call succeeded and output is saved at "${finalPath}", but failed to update unit to done in DB: ${doneUpdateError.message}`;
      console.error(
        `[UnitRunner] Loud failure: Failed to update unit to done (job: ${jobId}, stage: ${stage}, unit: ${unitIndex}): ${doneUpdateError.message}`,
      );
      return {
        skipped: false,
        success: false,
        outputPath: finalPath,
        error: dbErr,
      };
    }

    return {
      skipped: false,
      success: true,
      outputPath: finalPath,
      durationMs,
      costUsd,
    };
  } catch (postError) {
    const postErrMsg = postError instanceof Error ? postError.message : String(postError);
    const combinedError = `Provider call succeeded but post-processing failed: ${postErrMsg}`;

    const { error: failUpdateError } = await supabase
      .from('yt_job_units')
      .update({
        status: 'failed',
        attempts,
        output_path: finalPath ?? null,
        error: combinedError,
        updated_at: new Date().toISOString(),
      })
      .eq('job_id', jobId)
      .eq('stage', stage)
      .eq('unit_index', unitIndex);

    if (failUpdateError) {
      console.error(
        `[UnitRunner] Loud failure: Failed to update unit to failed after post-processing error (job: ${jobId}, stage: ${stage}, unit: ${unitIndex}): ${failUpdateError.message}`,
      );
    }

    return {
      skipped: false,
      success: false,
      outputPath: finalPath,
      error: combinedError,
    };
  }
}
