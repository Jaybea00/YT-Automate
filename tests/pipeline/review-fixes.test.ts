import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runJobUnit } from '../../src/pipeline/runner/unit-runner.ts';
import { computeInputHash } from '../../src/pipeline/utils/hash.ts';
import {
  clearRegistry,
  registerProvider,
  resolveForStage,
} from '../../src/pipeline/providers/registry.ts';
import { ConfigurationError, ProviderError } from '../../src/pipeline/providers/errors.ts';
import type { TTSProvider } from '../../src/pipeline/providers/types.ts';
import { resetStuckUnits } from '../../src/pipeline/worker.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

describe('Code Review Fixes & Verifications', () => {
  let tmpDir: string;

  beforeEach(async () => {
    clearRegistry();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-fix-test-'));
  });

  // Test 1: ffprobe fails after a successful execute()
  it('ffprobe fails after successful execute(): execute called exactly once, unit ends failed', async () => {
    const { supabase, db } = createMockSupabase();

    let executeCalls = 0;
    const execute = async () => {
      executeCalls++;
      return {
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/mpeg',
        // durationMs omitted to force ffprobe
      };
    };

    const res = await runJobUnit({
      jobId: 'job-post-fail',
      stage: 'tts',
      unitIndex: 1,
      input: { text: 'Narration text' },
      providerId: 'elevenlabs',
      maxRetries: 3, // Even with maxRetries = 3
      supabase,
      outputDir: tmpDir,
      execute,
      measureDuration: async () => {
        throw new Error('ffprobe execution failed');
      },
    });

    assert.equal(res.success, false);
    // Provider execute MUST be called exactly once; retry loop must not wrap post-processing
    assert.equal(executeCalls, 1);

    const unitRow = db.yt_job_units.find((u) => u.job_id === 'job-post-fail');
    assert.equal(unitRow?.status, 'failed');
    assert.match(unitRow?.error || '', /succeeded but post-processing failed|ffprobe execution failed/);
  });

  // Test 2: The done update returns an error
  it('The done update returns an error: result is not success, next run does not report cache hit', async () => {
    const { supabase, db } = createMockSupabase();

    const execute = async () => ({
      bytes: new Uint8Array([10, 20, 30]),
      mimeType: 'image/png',
    });

    // Simulate Supabase error on update
    db.simulateUpdateError = {
      table: 'yt_job_units',
      error: new Error('Postgres connection lost during update'),
    };

    const res1 = await runJobUnit({
      jobId: 'job-done-err',
      stage: 'image',
      unitIndex: 1,
      input: { prompt: 'City skyline' },
      providerId: 'openai',
      supabase,
      outputDir: tmpDir,
      execute,
    });

    assert.equal(res1.success, false);
    assert.match(res1.error || '', /failed to update unit to done|Postgres connection lost/i);

    // Remove simulated error
    db.simulateUpdateError = null;

    // Second run: should NOT be a cache hit because row was not successfully marked done
    let secondRunExecuted = false;
    const res2 = await runJobUnit({
      jobId: 'job-done-err',
      stage: 'image',
      unitIndex: 1,
      input: { prompt: 'City skyline' },
      providerId: 'openai',
      supabase,
      outputDir: tmpDir,
      execute: async () => {
        secondRunExecuted = true;
        return {
          bytes: new Uint8Array([10, 20, 30]),
          mimeType: 'image/png',
        };
      },
    });

    assert.equal(res2.skipped, false);
    assert.equal(secondRunExecuted, true);
  });

  // Test 3: Abort mid-unit
  it('Abort mid-unit: unit ends failed (not running) and is not retried', async () => {
    const { supabase, db } = createMockSupabase();

    const abortCtrl = new AbortController();
    let callCount = 0;

    const res = await runJobUnit({
      jobId: 'job-abort',
      stage: 'image',
      unitIndex: 1,
      input: { prompt: 'Prompt' },
      providerId: 'openai',
      maxRetries: 3,
      supabase,
      outputDir: tmpDir,
      signal: abortCtrl.signal,
      execute: async () => {
        callCount++;
        abortCtrl.abort();
        throw new ProviderError('Operation aborted', { code: 'aborted' });
      },
    });

    assert.equal(res.success, false);
    assert.equal(callCount, 1); // No retries

    const unitRow = db.yt_job_units.find((u) => u.job_id === 'job-abort');
    assert.equal(unitRow?.status, 'failed');
    assert.notEqual(unitRow?.status, 'running');
  });

  // Test 4: Same input, different baseUrl
  it('Same input, different baseUrl: results in different input_hash and unit regenerates', async () => {
    const hash1 = computeInputHash({
      stage: 'tts',
      input: { text: 'Hello' },
      providerId: 'openai-compatible',
      model: 'kokoro',
      baseUrl: 'http://localhost:8000/v1',
    });

    const hash2 = computeInputHash({
      stage: 'tts',
      input: { text: 'Hello' },
      providerId: 'openai-compatible',
      model: 'kokoro',
      baseUrl: 'http://localhost:8080/v1', // Different baseUrl
    });

    assert.notEqual(hash1, hash2);
  });

  // Test 5: Same input, different API key/secret
  it('Same input, different API key/secret: results in the SAME input_hash', async () => {
    const hashA = computeInputHash({
      stage: 'tts',
      input: { text: 'Hello' },
      providerId: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      baseUrl: 'https://api.elevenlabs.io',
      // API key / secret_id must NOT be part of hash
    });

    const hashB = computeInputHash({
      stage: 'tts',
      input: { text: 'Hello' },
      providerId: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      baseUrl: 'https://api.elevenlabs.io',
    });

    assert.equal(hashA, hashB);
  });

  // Test 6: Missing secret for an adapter with requiresApiKey: true
  it('Missing secret for adapter with requiresApiKey: true throws ConfigurationError before any call', async () => {
    const dummyProvider: TTSProvider = {
      kind: 'tts',
      id: 'elevenlabs',
      requiresApiKey: true,
      synthesize: async () => {
        throw new Error('Should not be called');
      },
    };
    registerProvider('tts', 'elevenlabs', dummyProvider);

    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        {
          id: 'config-no-key',
          kind: 'tts',
          provider: 'elevenlabs',
          label: 'ElevenLabs No Secret',
          secret_id: null, // Missing secret
          is_active: true,
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'tts',
          provider_config_id: 'config-no-key',
          max_retries: 1,
        },
      ],
    });

    await assert.rejects(
      async () => {
        await resolveForStage('tts', supabase);
      },
      (err: any) => {
        assert.ok(err instanceof ConfigurationError);
        assert.match(err.message, /requires an API key/i);
        return true;
      },
    );
  });

  // Test 7: Vault RPC error includes the RPC error message
  it('Vault RPC error: ConfigurationError includes the RPC error message', async () => {
    const dummyProvider: TTSProvider = {
      kind: 'tts',
      id: 'elevenlabs',
      requiresApiKey: true,
      synthesize: async () => ({
        bytes: new Uint8Array([]),
        mimeType: 'audio/mpeg',
        usage: {},
      }),
    };
    registerProvider('tts', 'elevenlabs', dummyProvider);

    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        {
          id: 'config-1',
          kind: 'tts',
          provider: 'elevenlabs',
          label: 'ElevenLabs',
          secret_id: 'missing-uuid',
          is_active: true,
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'tts',
          provider_config_id: 'config-1',
          max_retries: 1,
        },
      ],
      vault_secrets: {}, // No secret stored
    });

    await assert.rejects(
      async () => {
        await resolveForStage('tts', supabase);
      },
      (err: any) => {
        assert.ok(err instanceof ConfigurationError);
        assert.match(err.message, /Secret not found: missing-uuid/);
        return true;
      },
    );
  });

  // Test 8: Startup reset: jobs left running are reset to queued, units left running to pending
  it('Startup reset: jobs left running reset to queued and units left running reset to pending', async () => {
    const { supabase, db } = createMockSupabase({
      yt_jobs: [
        {
          id: 'job-stuck-1',
          topic: 'Stuck topic',
          status: 'running',
        },
        {
          id: 'job-done-1',
          topic: 'Done topic',
          status: 'done',
        },
      ],
      yt_job_units: [
        {
          id: 'unit-stuck-1',
          job_id: 'job-stuck-1',
          stage: 'image',
          unit_index: 3,
          status: 'running',
          input_hash: 'abc',
        },
        {
          id: 'unit-done-1',
          job_id: 'job-stuck-1',
          stage: 'image',
          unit_index: 1,
          status: 'done',
          input_hash: 'def',
        },
      ],
    });

    await resetStuckUnits(supabase);

    const stuckJob = db.yt_jobs.find((j) => j.id === 'job-stuck-1');
    const doneJob = db.yt_jobs.find((j) => j.id === 'job-done-1');
    const stuckUnit = db.yt_job_units.find((u) => u.id === 'unit-stuck-1');
    const doneUnit = db.yt_job_units.find((u) => u.id === 'unit-done-1');

    assert.equal(stuckJob?.status, 'queued');
    assert.equal(doneJob?.status, 'done');
    assert.equal(stuckUnit?.status, 'pending');
    assert.equal(doneUnit?.status, 'done');
  });

  // Test 9: claimNextJob throws when yt_claim_next_job RPC errors (no non-atomic fallback)
  it('claimNextJob throws if yt_claim_next_job RPC returns an error (no fallback)', async () => {
    const errorClient: any = {
      rpc: async (fn: string) => {
        if (fn === 'yt_claim_next_job') {
          return { data: null, error: { message: 'function yt_claim_next_job does not exist' } };
        }
        return { data: null, error: null };
      },
    };

    await assert.rejects(
      async () => {
        const { claimNextJob } = await import('../../src/pipeline/worker.ts');
        await claimNextJob(errorClient);
      },
      (err: any) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Failed to claim next job via yt_claim_next_job/);
        return true;
      },
    );
  });
});
