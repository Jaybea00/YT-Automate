import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdminClient } from './supabase-admin';
import { JobRunner } from './runner/job-runner';
import { releaseOvernightQueue } from './runner/overnight';
import { verifyFfmpegInstalled } from './utils/ffmpeg';
import './providers'; // Register all built-in providers

// Load environment variables from .env.local and .env if present
export function loadEnvFiles(): void {
  const envFiles = ['.env.local', '.env'];
  for (const file of envFiles) {
    const fullPath = path.resolve(process.cwd(), file);
    if (fs.existsSync(fullPath)) {
      try {
        // process.loadEnvFile exists from Node 20.12; older runtimes rely on the shell environment
        const loader = (process as { loadEnvFile?: (file: string) => void }).loadEnvFile;
        if (typeof loader === 'function') {
          loader.call(process, fullPath);
        }
      } catch {
        // Ignore parsing issues, environment variables already set take precedence
      }
    }
  }
}
loadEnvFiles();

let isShuttingDown = false;
let currentAbortController: AbortController | null = null;

/**
 * Resets any yt_jobs and yt_job_units left in 'running' state back to 'queued' and 'pending'.
 *
 * ARCHITECTURAL CONSTRAINT:
 * Exactly ONE worker instance is supported.
 * Running multiple worker instances concurrently with startup resets is not supported,
 * as one worker booting up would reset jobs or units that another active worker is processing.
 */
export async function resetStuckJobsAndUnits(supabase: SupabaseClient): Promise<void> {
  // 1. Reset stuck jobs: running -> queued
  const { error: jobsError } = await supabase
    .from('yt_jobs')
    .update({
      status: 'queued',
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'running');

  if (jobsError) {
    console.error(`[Worker] Error resetting stuck running jobs to queued: ${jobsError.message}`);
  } else {
    console.log('[Worker] Checked and reset any stale running jobs to queued.');
  }

  // 2. Reset stuck units: running -> pending
  const { error: unitsError } = await supabase
    .from('yt_job_units')
    .update({
      status: 'pending',
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'running');

  if (unitsError) {
    console.error(`[Worker] Error resetting stuck running units to pending: ${unitsError.message}`);
  } else {
    console.log('[Worker] Checked and reset any stale running units to pending.');
  }
}

export const resetStuckUnits = resetStuckJobsAndUnits;

/**
 * Atomically claims the next queued job using the yt_claim_next_job RPC (with FOR UPDATE SKIP LOCKED).
 * If the RPC errors, logs the error and throws without non-atomic fallbacks.
 */
export async function claimNextJob(
  supabase: SupabaseClient,
): Promise<{ id: string; topic: string } | null> {
  const { data, error } = await supabase.rpc('yt_claim_next_job');

  if (error) {
    console.error(`[Worker] Error executing yt_claim_next_job RPC: ${error.message}`);
    throw new Error(`Failed to claim next job via yt_claim_next_job: ${error.message}`);
  }

  if (Array.isArray(data) && data.length > 0) {
    return data[0];
  }

  return null;
}

let lastOvernightCheck = 0;

/** Once a minute: if the night window is open, the renders held for tonight become queued jobs. */
export async function checkOvernightQueue(supabase: SupabaseClient, now = Date.now()): Promise<void> {
  if (now - lastOvernightCheck < 60_000) return;
  lastOvernightCheck = now;
  try {
    const { started, failed } = await releaseOvernightQueue(supabase, { now: new Date(now) });
    if (started.length) console.log(`[Worker] Overnight queue: started ${started.length} render(s)`);
    if (failed.length) console.warn(`[Worker] Overnight queue: ${failed.length} render(s) could not start (kept, with the reason)`);
  } catch (err) {
    console.error('[Worker] Overnight queue check failed:', err);
  }
}

async function pollAndProcessOnce(supabase: SupabaseClient): Promise<boolean> {
  if (isShuttingDown) return false;

  await checkOvernightQueue(supabase);
  const job = await claimNextJob(supabase);
  if (!job) {
    return false;
  }

  console.log(`[Worker] Claimed and processing job ${job.id} ("${job.topic}")`);

  currentAbortController = new AbortController();
  const runner = new JobRunner({
    jobId: job.id,
    supabase,
    signal: currentAbortController.signal,
  });

  try {
    await runner.run();
    console.log(`[Worker] Successfully completed job ${job.id}`);
  } catch (err) {
    console.error(`[Worker] Job ${job.id} failed:`, err);
  } finally {
    currentAbortController = null;
  }

  return true;
}

export async function startWorker(options: {
  pollIntervalMs?: number;
  supabaseClient?: SupabaseClient;
  skipStartupChecks?: boolean;
} = {}): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  console.log('[Worker] Starting YT Pipeline worker...');

  // 1. Startup check: verify ffmpeg and ffprobe are executable
  if (!options.skipStartupChecks) {
    await verifyFfmpegInstalled();
    console.log('[Worker] Startup check passed: FFmpeg and ffprobe are executable.');
  }

  // 2. Initialize service-role admin Supabase client
  const supabase = options.supabaseClient ?? getSupabaseAdminClient();

  // 3. Reset stuck running jobs and units (supported for exactly ONE worker instance)
  await resetStuckJobsAndUnits(supabase);

  console.log(`[Worker] Worker active. Polling queued jobs every ${pollIntervalMs}ms...`);

  const shutdown = () => {
    if (isShuttingDown) return;
    console.log('[Worker] Graceful shutdown requested...');
    isShuttingDown = true;
    if (currentAbortController) {
      currentAbortController.abort();
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (!isShuttingDown) {
    try {
      const processed = await pollAndProcessOnce(supabase);
      if (!processed && !isShuttingDown) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } catch (err) {
      console.error('[Worker] Unexpected error in polling loop:', err);
      if (!isShuttingDown) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
  }

  console.log('[Worker] Worker stopped.');
}

// If executed directly from command line
if (typeof process !== 'undefined' && process.argv[1]?.includes('worker')) {
  startWorker().catch((err) => {
    console.error('[Worker] Fatal error:', err);
    process.exit(1);
  });
}
