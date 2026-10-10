import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runJobUnit } from '../../src/pipeline/runner/unit-runner.ts';
import { ProviderError } from '../../src/pipeline/providers/errors.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

describe('Acceptance Tests: Resume, Hashing & Resilience', () => {
  it('Acceptance Test 1: Same input rerun - all units skipped, zero provider calls', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-test-'));
    const { supabase, db } = createMockSupabase();

    let providerCallCount = 0;
    const execute = async () => {
      providerCallCount++;
      return {
        bytes: new Uint8Array([10, 20, 30]),
        mimeType: 'image/png',
        usage: { costUsd: 0.04 },
      };
    };

    // First run
    const result1 = await runJobUnit({
      jobId: 'job-1',
      stage: 'image',
      unitIndex: 1,
      input: { prompt: 'A cinematic drone shot of mountains' },
      providerId: 'openai',
      model: 'dall-e-3',
      options: { quality: 'hd' },
      supabase,
      outputDir: tmpDir,
      execute,
    });

    assert.equal(result1.success, true);
    assert.equal(result1.skipped, false);
    assert.equal(providerCallCount, 1);
    assert.equal(db.yt_job_units.length, 1);
    assert.equal(db.yt_job_units[0].status, 'done');

    // Second run with EXACT same input
    const result2 = await runJobUnit({
      jobId: 'job-1',
      stage: 'image',
      unitIndex: 1,
      input: { prompt: 'A cinematic drone shot of mountains' },
      providerId: 'openai',
      model: 'dall-e-3',
      options: { quality: 'hd' },
      supabase,
      outputDir: tmpDir,
      execute,
    });

    assert.equal(result2.success, true);
    assert.equal(result2.skipped, true);
    // Provider MUST NOT be called again
    assert.equal(providerCallCount, 1);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('Acceptance Test 2: Swap TTS binding mid-job - only TTS regenerates; image units are skipped', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-test-'));
    const { supabase } = createMockSupabase();

    let imageCallCount = 0;
    let ttsCallCount = 0;

    // Run Scene 1 Image with OpenAI
    const img1 = await runJobUnit({
      jobId: 'job-swap',
      stage: 'image',
      unitIndex: 1,
      input: { prompt: 'Scene 1 art' },
      providerId: 'openai',
      model: 'dall-e-3',
      supabase,
      outputDir: tmpDir,
      execute: async () => {
        imageCallCount++;
        return { bytes: new Uint8Array([1]), mimeType: 'image/png' };
      },
    });
    assert.equal(img1.success, true);
    assert.equal(imageCallCount, 1);

    // Run Scene 1 TTS with ElevenLabs
    const tts1 = await runJobUnit({
      jobId: 'job-swap',
      stage: 'tts',
      unitIndex: 1,
      input: { text: 'Scene 1 narration' },
      providerId: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      supabase,
      outputDir: tmpDir,
      execute: async () => {
        ttsCallCount++;
        return { bytes: new Uint8Array([2]), mimeType: 'audio/mpeg', durationMs: 1500 };
      },
    });
    assert.equal(tts1.success, true);
    assert.equal(ttsCallCount, 1);

    // NOW: Swap TTS binding to 'openai-compatible' (e.g. Kokoro / self-hosted)
    // Rerun Image (same input/provider)
    const img2 = await runJobUnit({
      jobId: 'job-swap',
      stage: 'image',
      unitIndex: 1,
      input: { prompt: 'Scene 1 art' },
      providerId: 'openai',
      model: 'dall-e-3',
      supabase,
      outputDir: tmpDir,
      execute: async () => {
        imageCallCount++;
        return { bytes: new Uint8Array([1]), mimeType: 'image/png' };
      },
    });

    // Image MUST be skipped!
    assert.equal(img2.skipped, true);
    assert.equal(imageCallCount, 1);

    // Rerun TTS with NEW provider
    const tts2 = await runJobUnit({
      jobId: 'job-swap',
      stage: 'tts',
      unitIndex: 1,
      input: { text: 'Scene 1 narration' },
      providerId: 'openai-compatible', // Swapped provider!
      model: 'kokoro-v1',
      supabase,
      outputDir: tmpDir,
      execute: async () => {
        ttsCallCount++;
        return { bytes: new Uint8Array([3]), mimeType: 'audio/mpeg', durationMs: 1600 };
      },
    });

    // TTS MUST regenerate!
    assert.equal(tts2.skipped, false);
    assert.equal(tts2.success, true);
    assert.equal(ttsCallCount, 2);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('Acceptance Test 3: Kill worker during scene 7, restart - resumes at scene 7 without regenerating scenes 1-6', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-test-'));
    const { supabase } = createMockSupabase();

    const providerCallCountPerScene: Record<number, number> = {};

    const executeScene = (sceneNum: number) => async () => {
      providerCallCountPerScene[sceneNum] = (providerCallCountPerScene[sceneNum] || 0) + 1;
      return {
        bytes: new Uint8Array([sceneNum]),
        mimeType: 'image/png',
      };
    };

    // 1. Run scenes 1 to 6 successfully
    for (let s = 1; s <= 6; s++) {
      await runJobUnit({
        jobId: 'job-crash',
        stage: 'image',
        unitIndex: s,
        input: { prompt: `Scene ${s} visuals` },
        providerId: 'openai',
        supabase,
        outputDir: tmpDir,
        execute: executeScene(s),
      });
    }

    // Verify scenes 1-6 ran once
    for (let s = 1; s <= 6; s++) {
      assert.equal(providerCallCountPerScene[s], 1);
    }

    // 2. Scene 7 starts and is killed/crashes
    const abortCtrl = new AbortController();
    abortCtrl.abort(); // Simulates worker process killed / shutdown

    const abortResult = await runJobUnit({
      jobId: 'job-crash',
      stage: 'image',
      unitIndex: 7,
      input: { prompt: 'Scene 7 visuals' },
      providerId: 'openai',
      supabase,
      outputDir: tmpDir,
      signal: abortCtrl.signal,
      execute: executeScene(7),
    });

    assert.equal(abortResult.success, false);
    assert.match(abortResult.error || '', /aborted/i);

    // 3. Worker restarts: runs all scenes 1 to 7
    for (let s = 1; s <= 7; s++) {
      const res = await runJobUnit({
        jobId: 'job-crash',
        stage: 'image',
        unitIndex: s,
        input: { prompt: `Scene ${s} visuals` },
        providerId: 'openai',
        supabase,
        outputDir: tmpDir,
        execute: executeScene(s),
      });

      if (s <= 6) {
        // Scenes 1 to 6 MUST be skipped!
        assert.equal(res.skipped, true);
        assert.equal(providerCallCountPerScene[s], 1, `Scene ${s} should not be regenerated`);
      } else {
        // Scene 7 resumes and succeeds
        assert.equal(res.skipped, false);
        assert.equal(res.success, true);
        assert.equal(providerCallCountPerScene[7], 1);
      }
    }

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('Acceptance Test 4: Invalid API key fails fast with auth and zero retries', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-test-'));
    const { supabase, db } = createMockSupabase();

    let attemptsCount = 0;

    const res = await runJobUnit({
      jobId: 'job-auth-fail',
      stage: 'tts',
      unitIndex: 1,
      input: { text: 'Hello' },
      providerId: 'elevenlabs',
      maxRetries: 3, // Even with maxRetries = 3
      supabase,
      outputDir: tmpDir,
      execute: async () => {
        attemptsCount++;
        throw new ProviderError('Unauthorized: invalid API key', { code: 'auth' });
      },
    });

    assert.equal(res.success, false);
    // Must fail fast: exactly 1 attempt, zero retries
    assert.equal(attemptsCount, 1);

    const unitRow = db.yt_job_units.find((u) => u.job_id === 'job-auth-fail');
    assert.equal(unitRow?.status, 'failed');
    assert.equal(unitRow?.attempts, 1);
    assert.match(unitRow?.error, /invalid API key/);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('Acceptance Test 5: Simulated timeout fails with no auto-retry, and manual rerun works', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-test-'));
    const { supabase, db } = createMockSupabase();

    let attemptCount = 0;
    let shouldTimeout = true;

    // Run 1: provider times out on generation call
    const run1 = await runJobUnit({
      jobId: 'job-timeout',
      stage: 'image',
      unitIndex: 1,
      input: { prompt: 'Complex render' },
      providerId: 'openai',
      maxRetries: 3,
      supabase,
      outputDir: tmpDir,
      execute: async () => {
        attemptCount++;
        if (shouldTimeout) {
          throw new ProviderError('Provider request timed out', { code: 'timeout' });
        }
        return {
          bytes: new Uint8Array([5, 6, 7]),
          mimeType: 'image/png',
        };
      },
    });

    assert.equal(run1.success, false);
    // Must NOT auto-retry on timeout
    assert.equal(attemptCount, 1);

    const unitRow1 = db.yt_job_units.find((u) => u.job_id === 'job-timeout');
    assert.equal(unitRow1?.status, 'failed');
    assert.equal(unitRow1?.attempts, 1);

    // Run 2: Manual rerun after timeout
    shouldTimeout = false;
    const run2 = await runJobUnit({
      jobId: 'job-timeout',
      stage: 'image',
      unitIndex: 1,
      input: { prompt: 'Complex render' },
      providerId: 'openai',
      maxRetries: 3,
      supabase,
      outputDir: tmpDir,
      execute: async () => {
        attemptCount++;
        return {
          bytes: new Uint8Array([5, 6, 7]),
          mimeType: 'image/png',
        };
      },
    });

    assert.equal(run2.success, true);
    assert.equal(attemptCount, 2);

    const unitRow2 = db.yt_job_units.find((u) => u.job_id === 'job-timeout');
    assert.equal(unitRow2?.status, 'done');
    assert.equal(unitRow2?.attempts, 2);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('TTS duration: measures duration and fails if ffprobe measurement fails', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-test-'));
    const { supabase, db } = createMockSupabase();

    // 1. Adapter does not return durationMs -> measureDuration callback is called
    let probeCalled = false;
    const resSuccess = await runJobUnit({
      jobId: 'job-probe',
      stage: 'tts',
      unitIndex: 1,
      input: { text: 'Speech' },
      providerId: 'elevenlabs',
      supabase,
      outputDir: tmpDir,
      execute: async () => ({
        bytes: new Uint8Array([1, 2]),
        mimeType: 'audio/mpeg',
        // durationMs omitted!
      }),
      measureDuration: async () => {
        probeCalled = true;
        return 3450;
      },
    });

    assert.equal(resSuccess.success, true);
    assert.equal(probeCalled, true);
    assert.equal(resSuccess.durationMs, 3450);

    // 2. If ffprobe is missing or fails, unit must fail (never use a fake duration)
    const resFail = await runJobUnit({
      jobId: 'job-probe-fail',
      stage: 'tts',
      unitIndex: 1,
      input: { text: 'Speech 2' },
      providerId: 'elevenlabs',
      supabase,
      outputDir: tmpDir,
      execute: async () => ({
        bytes: new Uint8Array([1, 2]),
        mimeType: 'audio/mpeg',
      }),
      measureDuration: async () => {
        throw new Error('ffprobe missing or corrupt audio file');
      },
    });

    assert.equal(resFail.success, false);
    assert.match(resFail.error || '', /ffprobe missing/);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
