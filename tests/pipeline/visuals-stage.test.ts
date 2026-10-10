import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createMockSupabase } from '../helpers/mock-supabase';
import { JobRunner } from '../../src/pipeline/runner/job-runner';
import { sourceVisualBeat } from '../../src/pipeline/visuals/beat-sourcer';
import { extractChartSpec, verifyNumbersInText } from '../../src/pipeline/visuals/chart-step';
import { resolveOfficialUrl } from '../../src/pipeline/visuals/screen-recording-step';
import { ProviderError } from '../../src/pipeline/providers/errors';
import {
  pickBestVideoCandidate,
  PixabayStockProvider,
  sanitizePixabayQuery,
} from '../../src/pipeline/providers/stock/pixabay';
import { extractStockKeywords } from '../../src/pipeline/visuals/stock-keywords';
import type {
  LLMProvider,
  ProviderCallContext,
  StockProvider,
  StockVideoCandidate,
} from '../../src/pipeline/providers/types';

describe('Part C Visuals Stage: Stock, Chart, Screen Recording & Provenance', () => {
  const dummyCtx: ProviderCallContext = {
    apiKey: 'test-key',
    options: {},
  };

  const sampleCandidates: StockVideoCandidate[] = [
    {
      id: 1,
      url: 'https://cdn.pixabay.com/test-short-720.mp4',
      width: 1280,
      height: 720,
      duration: 5,
      pageUrl: 'https://pixabay.com/videos/short-1/',
      attribution: 'UserA on Pixabay',
      files: [
        { url: 'https://cdn.pixabay.com/test-short-720.mp4', width: 1280, height: 720, quality: 'medium' },
      ],
    },
    {
      id: 2,
      url: 'https://cdn.pixabay.com/test-long-1080.mp4',
      width: 1920,
      height: 1080,
      duration: 15,
      pageUrl: 'https://pixabay.com/videos/long-2/',
      attribution: 'UserB on Pixabay',
      files: [
        { url: 'https://cdn.pixabay.com/test-long-1080.mp4', width: 1920, height: 1080, quality: 'large' },
        { url: 'https://cdn.pixabay.com/test-long-720.mp4', width: 1280, height: 720, quality: 'medium' },
      ],
    },
  ];

  function createMockStockProvider(candidates: StockVideoCandidate[] = sampleCandidates): StockProvider {
    return {
      kind: 'stock',
      id: 'pixabay',
      requiresApiKey: true,
      async searchVideos(_query: string, _ctx: ProviderCallContext) {
        return candidates;
      },
      async downloadVideo(_url: string, targetPath: string, _ctx?: ProviderCallContext) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, Buffer.from('FAKE-VIDEO-BYTES-MP4'));
        return targetPath;
      },
    };
  }

  function createMockLlmProvider(options?: {
    chartable?: boolean;
    seriesValues?: number[];
    resolvedUrl?: string | null;
  }): LLMProvider {
    return {
      kind: 'llm',
      id: 'mock-llm',
      async generateText() {
        return { text: 'ok', usage: {} };
      },
      async generateJson<T>(req: { schema: any }) {
        if (options?.resolvedUrl !== undefined) {
          return {
            data: {
              resolved: Boolean(options.resolvedUrl),
              url: options.resolvedUrl || undefined,
            } as T,
            usage: {},
          };
        }

        if (options?.chartable !== undefined) {
          return {
            data: {
              chartable: options.chartable,
              chartType: 'bar',
              title: 'Metric Overview',
              labels: ['Q1', 'Q2'],
              series: [
                {
                  name: 'Revenue',
                  values: options.seriesValues || [100, 200],
                },
              ],
            } as T,
            usage: {},
          };
        }

        return { data: {} as T, usage: {} };
      },
    };
  }

  // --------------------------------------------------------------------------
  // TEST 1: Chart step refuses to invent numbers
  // --------------------------------------------------------------------------
  it('chart step refuses to invent numbers: feed beat with no figures, falls back to stock not fabricated chart', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visuals-test-'));
    const { supabase, db } = createMockSupabase();

    const videoId = 'test-video-chart-refusal';
    const beat = {
      index: 1,
      text: 'The company expanded massively across Europe and customer satisfaction reached all-time records.',
      visual_type: 'chart' as const,
      visual_query: 'growth chart',
      duration_estimate_seconds: 6,
    };

    // LLM attempts to fabricate numbers (e.g. 500, 900) which do NOT appear in beat text
    const llmWithFabricatedNumbers = createMockLlmProvider({
      chartable: true,
      seriesValues: [500, 900],
    });

    const stockProvider = createMockStockProvider();

    try {
      const result = await sourceVisualBeat({
        jobId: 'job-chart-1',
        videoId,
        beat,
        targetDurationMs: 6000,
        outputDir: tempDir,
        supabase,
        stockProvider,
        stockCtx: dummyCtx,
        llmProvider: llmWithFabricatedNumbers,
        llmCtx: dummyCtx,
      });

      // Assert fallback occurred because numbers were not in text
      assert.equal(result.fallbackOccurred, true);
      assert.equal(result.finalVisualType, 'stock', 'Expected final visual type to fall back to stock');
      assert.match(result.outputPath, /visuals_beat_1\.mp4$/);

      // Verify provenance row in video_assets
      const asset = db.video_assets.find((a) => a.video_id === videoId && a.beat_index === 1);
      assert.ok(asset, 'Expected video_assets row to be created');
      assert.equal(asset.visual_type, 'stock', 'video_assets must reflect final asset type used');
      assert.equal(asset.license_type, 'royalty_free');
      assert.equal(asset.license_source, 'pixabay');
      assert.ok(asset.source_url);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // TEST 2: Screen recording failure -> stock fallback
  // --------------------------------------------------------------------------
  it('screen_recording failure -> stock fallback, assert logged and video_assets row reflects actual asset type used', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visuals-test-'));
    const { supabase, db } = createMockSupabase();

    const videoId = 'test-video-screen-rec-fail';
    const beat = {
      index: 2,
      text: 'Developers integrate using our cloud API endpoints.',
      visual_type: 'screen_recording' as const,
      visual_query: 'nonexistent documentation page at bad domain',
      duration_estimate_seconds: 5,
    };

    // LLM cannot resolve to a confident official domain
    const llmUnresolvable = createMockLlmProvider({
      resolvedUrl: null,
    });

    const stockProvider = createMockStockProvider();

    try {
      const result = await sourceVisualBeat({
        jobId: 'job-screen-1',
        videoId,
        beat,
        targetDurationMs: 5000,
        outputDir: tempDir,
        supabase,
        stockProvider,
        stockCtx: dummyCtx,
        llmProvider: llmUnresolvable,
        llmCtx: dummyCtx,
      });

      // Assert fallback occurred
      assert.equal(result.fallbackOccurred, true);
      assert.equal(result.finalVisualType, 'stock');

      // Assert video_assets reflects the actual asset type used (stock)
      const asset = db.video_assets.find((a) => a.video_id === videoId && a.beat_index === 2);
      assert.ok(asset, 'Expected video_assets row to be created');
      assert.equal(asset.visual_type, 'stock', 'Final asset type must be stock, not screen_recording');
      assert.equal(asset.license_type, 'royalty_free');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // TEST 3: Visuals job resumes mid-stage without re-sourcing already-done beats
  // --------------------------------------------------------------------------
  it("a 'visuals' job resumes mid-stage without re-sourcing already-done beats", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visuals-test-'));
    const jobId = 'job-resume-test';
    const videoId = 'video-resume-test';

    // Create an existing file on disk for beat 1
    const doneBeat1Path = path.join(tempDir, 'visuals', 'visuals_beat_1.mp4');
    await fs.mkdir(path.dirname(doneBeat1Path), { recursive: true });
    await fs.writeFile(doneBeat1Path, Buffer.from('PRE-EXISTING-DONE-ASSET'));

    const scenes = [
      {
        scene_number: 1,
        narration: 'First beat already complete',
        visual_prompt: 'tech office',
        visual_type: 'stock' as const,
        visual_query: 'tech office',
        duration_estimate_seconds: 5,
      },
      {
        scene_number: 2,
        narration: 'Second beat needing sourcing',
        visual_prompt: 'server room',
        visual_type: 'stock' as const,
        visual_query: 'server room',
        duration_estimate_seconds: 7,
      },
    ];

    // Compute input hash for beat 1 matching unit-runner's hashing
    const { computeInputHash } = await import('../../src/pipeline/utils/hash');
    const beat1InputHash = computeInputHash({
      stage: 'visuals',
      input: {
        sceneNumber: 1,
        visualType: 'stock',
        visualQuery: 'tech office',
        narration: 'First beat already complete',
        targetDurationMs: 5000,
      },
      providerId: 'pixabay',
      model: null,
      options: {},
    });

    const { supabase, db } = createMockSupabase({
      yt_jobs: [
        {
          id: jobId,
          video_id: videoId,
          topic: 'Resume Test',
          template: 'tech',
          status: 'running',
          stages: ['visuals'],
          script: { scenes },
          script_fingerprint: 'dummy-fp',
        },
      ],
      yt_job_stages: [
        {
          job_id: jobId,
          stage: 'visuals',
          status: 'running',
        },
      ],
      yt_job_units: [
        {
          job_id: jobId,
          stage: 'visuals',
          unit_index: 1,
          status: 'done',
          input_hash: beat1InputHash,
          output_path: doneBeat1Path,
          duration_ms: 5000,
          attempts: 1,
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'visuals',
          provider_config_id: 'cfg-stock',
          model: null,
          options: {},
          max_retries: 1,
        },
        {
          stage: 'script',
          provider_config_id: 'cfg-llm',
          model: 'gpt-4o',
          options: {},
          max_retries: 1,
        },
      ],
      yt_provider_configs: [
        {
          id: 'cfg-stock',
          kind: 'stock',
          provider: 'pixabay',
          label: 'Pixabay',
          secret_id: 'sec-pixabay',
          is_active: true,
        },
        {
          id: 'cfg-llm',
          kind: 'llm',
          provider: 'openai',
          label: 'OpenAI',
          secret_id: 'sec-openai',
          is_active: true,
        },
      ],
      vault_secrets: {
        'sec-pixabay': 'test-pixabay-key',
        'sec-openai': 'test-openai-key',
      },
    });

    let beat1DownloadCount = 0;
    let beat2DownloadCount = 0;

    const mockStock: StockProvider = {
      kind: 'stock',
      id: 'pixabay',
      requiresApiKey: true,
      async searchVideos(q: string) {
        return sampleCandidates;
      },
      async downloadVideo(url: string, targetPath: string) {
        if (targetPath.includes('beat_1')) {
          beat1DownloadCount++;
        }
        if (targetPath.includes('beat_2')) {
          beat2DownloadCount++;
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, Buffer.from('DOWNLOADED-DATA'));
        return targetPath;
      },
    };

    const { registerProvider } = await import('../../src/pipeline/providers/registry');
    registerProvider('stock', 'pixabay', mockStock);
    registerProvider('llm', 'openai', createMockLlmProvider());

    try {
      const runner = new JobRunner({
        jobId,
        supabase,
        baseOutputDir: tempDir,
      });

      await runner.runVisualsStage();

      // Assert beat 1 was skipped from cache and NOT downloaded again
      assert.equal(beat1DownloadCount, 0, 'Beat 1 should have been skipped from checkpoint cache');
      // Assert beat 2 was newly sourced and downloaded
      assert.equal(beat2DownloadCount, 1, 'Beat 2 should have been newly downloaded');

      // Assert both units are done in the database
      const units = db.yt_job_units.filter((u) => u.job_id === jobId && u.stage === 'visuals');
      assert.equal(units.length, 2);
      assert.equal(units[0].status, 'done');
      assert.equal(units[1].status, 'done');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // TEST 4: Visual duration sizing pulls from TTS unit duration_ms, not script estimate
  // --------------------------------------------------------------------------
  it('visual duration sizing pulls from tts unit duration_ms, not the script estimate', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visuals-test-'));
    const jobId = 'job-duration-sizing-test';
    const videoId = 'video-duration-sizing-test';

    const scriptEstimateSeconds = 14; // Script estimated 14s (14,000ms)
    const measuredTtsDurationMs = 8240; // Real spoken TTS measured via ffprobe is 8.24s (8,240ms)

    const scenes = [
      {
        scene_number: 1,
        narration: 'Narration spoken at natural conversational pace.',
        visual_prompt: 'quantum computer lab',
        visual_type: 'stock' as const,
        visual_query: 'quantum computer',
        duration_estimate_seconds: scriptEstimateSeconds, // 14s estimate
      },
    ];

    const { supabase, db } = createMockSupabase({
      yt_jobs: [
        {
          id: jobId,
          video_id: videoId,
          topic: 'Duration Sizing Test',
          template: 'tech',
          status: 'running',
          stages: ['visuals'],
          script: { scenes },
          script_fingerprint: 'fp-duration-1',
        },
      ],
      yt_job_stages: [
        {
          job_id: jobId,
          stage: 'visuals',
          status: 'running',
        },
      ],
      // Existing completed TTS unit for scene 1 with measured duration_ms = 8240
      yt_job_units: [
        {
          job_id: jobId,
          stage: 'tts',
          unit_index: 1,
          status: 'done',
          duration_ms: measuredTtsDurationMs, // 8,240ms (differs significantly from 14,000ms estimate)
          output_path: '/fake/tts_scene_1.mp3',
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'visuals',
          provider_config_id: 'cfg-stock-dur',
          model: null,
          options: {},
          max_retries: 1,
        },
        {
          stage: 'script',
          provider_config_id: 'cfg-llm-dur',
          model: 'gpt-4o',
          options: {},
          max_retries: 1,
        },
      ],
      yt_provider_configs: [
        {
          id: 'cfg-stock-dur',
          kind: 'stock',
          provider: 'pixabay',
          label: 'Pixabay',
          secret_id: 'sec-pixabay-dur',
          is_active: true,
        },
        {
          id: 'cfg-llm-dur',
          kind: 'llm',
          provider: 'openai',
          label: 'OpenAI',
          secret_id: 'sec-openai-dur',
          is_active: true,
        },
      ],
      vault_secrets: {
        'sec-pixabay-dur': 'test-key',
        'sec-openai-dur': 'test-key',
      },
    });

    let queriedDurationSeconds: number | null = null;

    const mockStock: StockProvider = {
      kind: 'stock',
      id: 'pixabay',
      requiresApiKey: true,
      async searchVideos(_query: string) {
        return sampleCandidates;
      },
      async downloadVideo(_url: string, targetPath: string) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, Buffer.from('VIDEO-DATA'));
        return targetPath;
      },
    };

    const { registerProvider } = await import('../../src/pipeline/providers/registry');
    registerProvider('stock', 'pixabay', mockStock);
    registerProvider('llm', 'openai', createMockLlmProvider());

    try {
      const runner = new JobRunner({
        jobId,
        supabase,
        baseOutputDir: tempDir,
      });

      await runner.runVisualsStage();

      // Check the created visuals unit checkpoint in yt_job_units
      const visualsUnit = db.yt_job_units.find(
        (u) => u.job_id === jobId && u.stage === 'visuals' && u.unit_index === 1,
      );

      assert.ok(visualsUnit, 'Expected visuals unit checkpoint to exist in DB');
      assert.equal(visualsUnit.status, 'done');

      // ASSERTION: Must equal measured TTS duration_ms (8240), NOT script estimate (14000)
      assert.equal(
        visualsUnit.duration_ms,
        measuredTtsDurationMs,
        `Visual unit duration (${visualsUnit.duration_ms}) must equal TTS measured duration (${measuredTtsDurationMs}), not the script estimate (${scriptEstimateSeconds * 1000})`,
      );
      assert.notEqual(
        visualsUnit.duration_ms,
        scriptEstimateSeconds * 1000,
        'Visual unit duration must not use the inaccurate script estimate',
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // TEST 5: Pixabay candidate selection prioritizes duration and resolution
  // --------------------------------------------------------------------------
  it('pickBestVideoCandidate selects resolution and duration meeting TTS target', () => {
    const candidates: StockVideoCandidate[] = [
      {
        id: 1,
        url: 'https://cdn.pixabay.com/clip-720p-4s.mp4',
        width: 1280,
        height: 720,
        duration: 4,
        files: [{ url: 'https://cdn.pixabay.com/clip-720p-4s.mp4', width: 1280, height: 720 }],
      },
      {
        id: 2,
        url: 'https://cdn.pixabay.com/clip-1080p-10s.mp4',
        width: 1920,
        height: 1080,
        duration: 10,
        files: [{ url: 'https://cdn.pixabay.com/clip-1080p-10s.mp4', width: 1920, height: 1080 }],
      },
      {
        id: 3,
        url: 'https://cdn.pixabay.com/clip-720p-12s.mp4',
        width: 1280,
        height: 720,
        duration: 12,
        files: [{ url: 'https://cdn.pixabay.com/clip-720p-12s.mp4', width: 1280, height: 720 }],
      },
    ];

    // For a TTS duration of 8 seconds:
    // Candidate 1 is too short (4s)
    // Candidate 2 is 1080p and 10s (meets duration + highest resolution)
    // Candidate 3 is 720p and 12s
    const picked = pickBestVideoCandidate(candidates, 8);
    assert.ok(picked);
    assert.equal(picked.candidate.id, 2);
    assert.equal(picked.width, 1920);
    assert.equal(picked.height, 1080);
  });

  // --------------------------------------------------------------------------
  // TEST 6: Pixabay response validation against Zod schema
  // --------------------------------------------------------------------------
  it('validates Pixabay search response against PixabayResponseSchema and rejects malformed responses', async () => {
    const { PixabayResponseSchema } = await import('../../src/pipeline/providers/stock/pixabay');

    // Valid sample response matching live Pixabay API
    const validPixabayJson = {
      total: 100,
      totalHits: 50,
      hits: [
        {
          id: 12345,
          pageURL: 'https://pixabay.com/videos/test-12345/',
          duration: 15,
          tags: 'tech, ai',
          videos: {
            large: {
              url: 'https://cdn.pixabay.com/video/large.mp4',
              width: 1920,
              height: 1080,
              size: 5000000,
            },
            medium: {
              url: 'https://cdn.pixabay.com/video/medium.mp4',
              width: 1280,
              height: 720,
              size: 2500000,
            },
          },
        },
      ],
    };

    const validResult = PixabayResponseSchema.safeParse(validPixabayJson);
    assert.equal(validResult.success, true);
    if (validResult.success) {
      assert.equal(validResult.data.hits.length, 1);
      assert.equal(validResult.data.hits[0].id, 12345);
      assert.equal(validResult.data.hits[0].videos.large?.width, 1920);
    }

    // Malformed response (e.g. hits is not an array, or duration missing/invalid)
    const malformedJson = {
      total: 1,
      hits: 'not-an-array',
    };

    const invalidResult = PixabayResponseSchema.safeParse(malformedJson);
    assert.equal(invalidResult.success, false);
  });

  // --------------------------------------------------------------------------
  // TEST 7: Query sanitization & 100 character safety net in pixabay.ts
  // --------------------------------------------------------------------------
  it('sanitizePixabayQuery truncates >100 char queries at word boundary without cutting mid-word', () => {
    const longQuery = "Electricity Maps live dashboard comparing France's low carbon intensity against Germany's coal reliance";
    assert.ok(longQuery.length > 100, `Expected length > 100, got ${longQuery.length}`);

    const sanitized = sanitizePixabayQuery(longQuery);
    assert.ok(sanitized.length <= 100, `Expected length <= 100, got ${sanitized.length}`);
    // Should break cleanly at a word boundary (e.g. ends with 'coal', not mid-word 'relia')
    assert.equal(sanitized.endsWith('coal'), true);

    // Continuous word without spaces should be strictly capped at 100 chars
    const continuousWord = 'a'.repeat(120);
    const sanitizedContinuous = sanitizePixabayQuery(continuousWord);
    assert.equal(sanitizedContinuous.length, 100);

    // Short query is preserved
    assert.equal(sanitizePixabayQuery('nuclear power plant'), 'nuclear power plant');
  });

  // --------------------------------------------------------------------------
  // TEST 8: Conversion of long visual_query into short keyword phrase
  // --------------------------------------------------------------------------
  it('extractStockKeywords distills long visual query into short keyword phrase', async () => {
    const longQuery = "Electricity Maps live dashboard comparing France's low carbon intensity against Germany's coal reliance";
    const keywords = await extractStockKeywords(longQuery);

    assert.ok(keywords.length <= 60, `Keywords should be short, got ${keywords.length} chars`);
    const wordCount = keywords.split(/\s+/).length;
    assert.ok(wordCount >= 2 && wordCount <= 5, `Expected 2-5 words, got ${wordCount}: "${keywords}"`);
    // Should filter out camera/meta words like 'dashboard', 'comparing', 'live'
    assert.ok(!keywords.includes('dashboard'));
    assert.ok(!keywords.includes('comparing'));
    assert.ok(!keywords.includes('live'));
  });

  // --------------------------------------------------------------------------
  // TEST 9: visual_query over 100 characters does not throw and gets shortened before reaching Pixabay
  // --------------------------------------------------------------------------
  it('visual_query over 100 characters gets shortened before reaching stock adapter and does not throw', async () => {
    let capturedQuery = '';
    const mockStock: StockProvider = {
      kind: 'stock',
      id: 'pixabay',
      requiresApiKey: true,
      async searchVideos(query: string) {
        capturedQuery = query;
        // Verify that the query received by the stock search adapter is <= 100 characters
        if (query.length > 100) {
          throw new Error(`[ERROR 400] Search query 'q' may not exceed 100 characters. Received: ${query.length}`);
        }
        return sampleCandidates;
      },
      async downloadVideo(_url: string, targetPath: string) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, Buffer.from('FAKE-VIDEO'));
        return targetPath;
      },
    };

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-visuals-test-longq-'));
    const { supabase } = createMockSupabase();

    const longQuery = "Electricity Maps live dashboard comparing France's low carbon intensity against Germany's coal reliance";

    const result = await sourceVisualBeat({
      jobId: 'job-long-query',
      videoId: 'vid-long-query',
      beat: {
        index: 12,
        text: 'France emits significantly less CO2 per kilowatt-hour than Germany due to its nuclear fleet.',
        visual_type: 'stock',
        visual_query: longQuery,
      },
      targetDurationMs: 5000,
      outputDir: tempDir,
      supabase,
      stockProvider: mockStock,
      stockCtx: dummyCtx,
    });

    assert.ok(result.outputPath, 'Output path should be returned');
    assert.equal(result.finalVisualType, 'stock');
    assert.ok(capturedQuery.length <= 100, `Stock adapter received query > 100 chars: "${capturedQuery}"`);
    assert.ok(capturedQuery.split(/\s+/).length <= 6, `Stock query should be 3-6 keywords, got: "${capturedQuery}"`);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // TEST 10: extractChartSpec retries transient 503 error and succeeds on retry
  // --------------------------------------------------------------------------
  it('extractChartSpec retries transient 503 error and succeeds on subsequent attempt', async () => {
    let callCount = 0;
    const retryableLlm: LLMProvider = {
      kind: 'llm',
      id: 'mock-flaky-llm',
      async generateText() {
        return { text: 'ok', usage: {} };
      },
      async generateJson<T>() {
        callCount++;
        if (callCount === 1) {
          // Simulate transient 503 error on first call
          throw new ProviderError('503 Service Unavailable: High demand spikes', {
            code: 'transient',
            retryAfterMs: 10,
          });
        }
        return {
          data: {
            chartable: true,
            chartType: 'bar',
            title: 'Revenue 2024',
            labels: ['Q1', 'Q2'],
            series: [{ name: 'Revenue', values: [100, 200] }],
          } as T,
          usage: {},
        };
      },
    };

    const spec = await extractChartSpec(
      { text: 'In 2024, Q1 revenue was 100 and Q2 was 200.', visualQuery: 'chart' },
      retryableLlm,
      dummyCtx,
    );

    assert.equal(callCount, 2, 'Expected LLM provider to be called twice (initial + 1 retry)');
    assert.equal(spec.chartable, true);
    assert.equal(spec.chartType, 'bar');
  });

  // --------------------------------------------------------------------------
  // TEST 11: resolveOfficialUrl retries transient 503 error and succeeds on retry
  // --------------------------------------------------------------------------
  it('resolveOfficialUrl retries transient 503 error and succeeds on subsequent attempt', async () => {
    let callCount = 0;
    const retryableLlm: LLMProvider = {
      kind: 'llm',
      id: 'mock-flaky-llm',
      async generateText() {
        return { text: 'ok', usage: {} };
      },
      async generateJson<T>() {
        callCount++;
        if (callCount === 1) {
          // Simulate transient 503 error on first call
          throw new ProviderError('503 Service Unavailable: Overloaded', {
            code: 'transient',
            retryAfterMs: 10,
          });
        }
        return {
          data: {
            resolved: true,
            url: 'https://developer.mozilla.org',
          } as T,
          usage: {},
        };
      },
    };

    const resolution = await resolveOfficialUrl(
      { visualQuery: 'MDN documentation', text: 'Web docs' },
      retryableLlm,
      dummyCtx,
    );

    assert.equal(callCount, 2, 'Expected LLM provider to be called twice (initial + 1 retry)');
    assert.equal(resolution.resolved, true);
    assert.equal(resolution.url, 'https://developer.mozilla.org');
  });
});

