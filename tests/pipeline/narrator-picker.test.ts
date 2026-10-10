import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRegistry,
  registerProvider,
  resolveForStage,
} from '../../src/pipeline/providers/registry.ts';
import { ConfigurationError } from '../../src/pipeline/providers/errors.ts';
import type { TTSProvider } from '../../src/pipeline/providers/types.ts';
import { handleNarratorSync } from '../../src/app/api/narrators/sync/route.ts';
import { handleGetNarrators } from '../../src/app/api/narrators/route.ts';
import {
  handleGetDefaults,
  handleSetDefaults,
} from '../../src/app/api/narrators/defaults/route.ts';
import { handleVoiceRequest } from '../../src/app/api/videos/[id]/voice/route.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

describe('Narrator Picker & Style Defaults', () => {
  beforeEach(() => {
    clearRegistry();
  });

  const mockKokoroConfigId = 'kokoro-cfg-123';
  const mockElevenLabsConfigId = 'eleven-cfg-456';

  it('1. Narrator sync upserts without duplicating on re-sync', async () => {
    let listVoicesCallCount = 0;
    const dummyKokoroProvider: TTSProvider = {
      kind: 'tts',
      id: 'openai-compatible',
      requiresApiKey: false,
      synthesize: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/wav',
        durationMs: 1000,
      }),
      listVoices: async () => {
        listVoicesCallCount++;
        return [
          {
            id: 'af_bella',
            name: 'Bella',
            sampleUrl: null,
            tier: 'high',
          },
          {
            id: 'am_adam',
            name: 'Adam',
            sampleUrl: null,
            tier: 'medium',
          },
        ];
      },
    };

    registerProvider('tts', 'openai-compatible', dummyKokoroProvider);

    const { supabase, db } = createMockSupabase({
      yt_provider_configs: [
        {
          id: mockKokoroConfigId,
          kind: 'tts',
          provider: 'openai-compatible',
          label: 'Kokoro Local TTS',
          base_url: 'http://localhost:8880/v1',
          options: { voice: 'af_bella' },
          is_active: true,
        },
      ],
      narrators: [],
    });

    // First Sync
    const req1 = new Request('http://localhost:3000/api/narrators/sync', {
      method: 'POST',
      body: JSON.stringify({ providerConfigId: mockKokoroConfigId }),
    });

    const res1 = await handleNarratorSync(req1, supabase);
    assert.equal(res1.status, 200);
    const json1 = await res1.json();
    assert.equal(json1.success, true);
    assert.equal(json1.totalSynced, 2);
    assert.equal(db.narrators.length, 2);

    const firstBella = db.narrators.find((n) => n.voice_id === 'af_bella');
    assert.ok(firstBella);
    assert.equal(firstBella?.name, 'Bella');
    assert.equal(firstBella?.tier, 'high');

    // Second Sync (Re-sync same voices with an updated tier / name)
    dummyKokoroProvider.listVoices = async () => [
      {
        id: 'af_bella',
        name: 'Bella Updated',
        sampleUrl: 'https://example.com/bella.mp3',
        tier: 'top',
      },
      {
        id: 'am_adam',
        name: 'Adam',
        sampleUrl: null,
        tier: 'medium',
      },
    ];

    const req2 = new Request('http://localhost:3000/api/narrators/sync', {
      method: 'POST',
      body: JSON.stringify({ providerConfigId: mockKokoroConfigId }),
    });

    const res2 = await handleNarratorSync(req2, supabase);
    assert.equal(res2.status, 200);
    const json2 = await res2.json();
    assert.equal(json2.success, true);
    assert.equal(json2.totalSynced, 2);

    // CRITICAL: Ensure no duplicates were created
    assert.equal(db.narrators.length, 2, 'Narrator table must not duplicate rows on re-sync');

    const updatedBella = db.narrators.find((n) => n.voice_id === 'af_bella');
    assert.equal(updatedBella?.id, firstBella?.id, 'Row ID must be preserved on upsert');
    assert.equal(updatedBella?.name, 'Bella Updated');
    assert.equal(updatedBella?.sample_url, 'https://example.com/bella.mp3');
    assert.equal(updatedBella?.tier, 'top');
  });

  it('2. Voice override via narratorId changes options.voice for that job without mutating provider_configs', async () => {
    const dummyProvider: TTSProvider = {
      kind: 'tts',
      id: 'openai-compatible',
      requiresApiKey: false,
      synthesize: async () => ({
        bytes: new Uint8Array([1]),
        mimeType: 'audio/wav',
        durationMs: 500,
      }),
    };
    registerProvider('tts', 'openai-compatible', dummyProvider);

    const initialProviderOptions = { voice: 'af_bella', speed: 1.0 };
    const narratorId = 'narrator-adam-uuid';

    const { supabase, db } = createMockSupabase({
      yt_provider_configs: [
        {
          id: mockKokoroConfigId,
          kind: 'tts',
          provider: 'openai-compatible',
          label: 'Kokoro Local TTS',
          base_url: 'http://localhost:8880/v1',
          options: { ...initialProviderOptions },
          is_active: true,
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'tts',
          provider_config_id: mockKokoroConfigId,
          options: { speed: 1.05 },
          max_retries: 2,
        },
      ],
      narrators: [
        {
          id: narratorId,
          provider_config_id: mockKokoroConfigId,
          voice_id: 'am_adam',
          name: 'Adam',
          tier: 'high',
        },
      ],
      videos: [
        {
          id: 'video-test-1',
          title: 'Testing Voice Overrides',
          status: 'script_review',
          style: 'true_crime_pov',
          script_json: {
            beats: [
              {
                index: 1,
                text: 'The detective stepped into the dimly lit hallway.',
                visual_type: 'b-roll',
                visual_query: 'hallway',
                duration_estimate_seconds: 5,
              },
            ],
          },
        },
      ],
      yt_jobs: [],
    });

    // 1. Trigger voice route with narratorId
    const req = new Request('http://localhost:3000/api/videos/video-test-1/voice', {
      method: 'POST',
      body: JSON.stringify({ narratorId }),
    });

    const res = await handleVoiceRequest(req, 'video-test-1', supabase);
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.voiceId, 'am_adam');
    assert.equal(json.narratorId, narratorId);
    assert.equal(json.ttsProviderConfigId, mockKokoroConfigId);

    // Verify job in database has voice_id and voice_override set
    const createdJob = db.yt_jobs[0];
    assert.ok(createdJob);
    assert.equal(createdJob.script.voice_id, 'am_adam');
    assert.equal(createdJob.script.voice_override, 'am_adam');
    assert.equal(createdJob.script.narrator_id, narratorId);

    // 2. Resolve for stage using the job's voice override
    const resolved = await resolveForStage(
      'tts',
      supabase,
      createdJob.script.tts_provider_config_id,
      createdJob.script.voice_override,
    );

    // Options must reflect the voice override
    assert.equal(resolved.options.voice, 'am_adam');
    assert.equal(resolved.options.voiceId, 'am_adam');
    assert.equal(resolved.ctx.options.voice, 'am_adam');
    assert.equal(resolved.ctx.options.voiceId, 'am_adam');

    // 3. CRITICAL: The yt_provider_configs row must NOT have been mutated
    const providerConfigRow = db.yt_provider_configs.find((c) => c.id === mockKokoroConfigId);
    assert.ok(providerConfigRow);
    assert.deepEqual(
      providerConfigRow.options,
      initialProviderOptions,
      'yt_provider_configs row options must remain completely unmutated',
    );
  });

  it('3. Override works with zero default bindings present (fixes no-default-binding bug)', async () => {
    const dummyProvider: TTSProvider = {
      kind: 'tts',
      id: 'openai-compatible',
      requiresApiKey: false,
      synthesize: async () => ({
        bytes: new Uint8Array([1]),
        mimeType: 'audio/wav',
        durationMs: 500,
      }),
    };
    registerProvider('tts', 'openai-compatible', dummyProvider);

    const { supabase, db } = createMockSupabase({
      yt_provider_configs: [
        {
          id: mockKokoroConfigId,
          kind: 'tts',
          provider: 'openai-compatible',
          label: 'Kokoro Standalone',
          base_url: 'http://localhost:8880/v1',
          options: { voice: 'af_default' },
          is_active: true,
        },
      ],
      // ZERO stage bindings present in the database!
      yt_stage_bindings: [],
    });

    // Case A: Calling without override when no default binding exists throws ConfigurationError
    await assert.rejects(
      async () => {
        await resolveForStage('tts', supabase);
      },
      (err: any) => {
        assert.ok(err instanceof ConfigurationError);
        assert.match(err.message, /No stage binding configured for stage "tts"/);
        return true;
      },
    );

    // Case B: Calling WITH overrideConfigId and optional voiceOverride MUST SUCCEED with zero bindings
    const resolved = await resolveForStage(
      'tts',
      supabase,
      mockKokoroConfigId,
      'am_michael',
    );

    assert.ok(resolved, 'resolveForStage must succeed when an override is provided without default bindings');
    assert.equal(resolved.configId, mockKokoroConfigId);
    assert.equal(resolved.providerId, 'openai-compatible');
    assert.equal(resolved.options.voice, 'am_michael');
    assert.equal(resolved.options.voiceId, 'am_michael');
    assert.equal(resolved.maxRetries, 1, 'Defaults to 1 retry when no stage binding row exists');
  });

  it('4. Style-to-narrator defaults: save and retrieve defaults per video style', async () => {
    const narratorId1 = 'narrator-uuid-tech';
    const narratorId2 = 'narrator-uuid-crime';

    const { supabase, db } = createMockSupabase({
      style_narrator_defaults: [],
      narrators: [
        { id: narratorId1, name: 'Tech Voice' },
        { id: narratorId2, name: 'Crime Voice' },
      ],
    });

    // Set default for tech
    const req1 = new Request('http://localhost:3000/api/narrators/defaults', {
      method: 'POST',
      body: JSON.stringify({ style: 'tech', narratorId: narratorId1 }),
    });
    const res1 = await handleSetDefaults(req1, supabase);
    assert.equal(res1.status, 200);

    // Set default for true_crime_pov via batch defaults map
    const req2 = new Request('http://localhost:3000/api/narrators/defaults', {
      method: 'POST',
      body: JSON.stringify({
        defaults: {
          true_crime_pov: narratorId2,
        },
      }),
    });
    const res2 = await handleSetDefaults(req2, supabase);
    assert.equal(res2.status, 200);

    // Retrieve defaults
    const getRes = await handleGetDefaults(supabase);
    assert.equal(getRes.status, 200);
    const getJson = await getRes.json();
    assert.deepEqual(getJson.defaults, {
      tech: narratorId1,
      true_crime_pov: narratorId2,
    });

    // Clear tech default (pass null/empty)
    const reqClear = new Request('http://localhost:3000/api/narrators/defaults', {
      method: 'POST',
      body: JSON.stringify({ style: 'tech', narratorId: null }),
    });
    await handleSetDefaults(reqClear, supabase);

    const getResAfter = await handleGetDefaults(supabase);
    const getJsonAfter = await getResAfter.json();
    assert.equal(getJsonAfter.defaults.tech, undefined);
    assert.equal(getJsonAfter.defaults.true_crime_pov, narratorId2);
  });

  it('5. GET /api/narrators returns all narrators joined with provider config info', async () => {
    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        {
          id: mockKokoroConfigId,
          kind: 'tts',
          provider: 'openai-compatible',
          label: 'Kokoro Provider',
          is_active: true,
        },
      ],
      narrators: [
        {
          id: 'n-1',
          provider_config_id: mockKokoroConfigId,
          voice_id: 'af_bella',
          name: 'Bella',
          sample_url: 'https://example.com/audio.mp3',
          tier: 'high',
          created_at: '2026-10-01T00:00:00Z',
        },
      ],
    });

    const res = await handleGetNarrators(supabase);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'n-1');
    assert.equal(list[0].name, 'Bella');
    assert.ok(list[0].yt_provider_configs);
    assert.equal(list[0].yt_provider_configs.label, 'Kokoro Provider');
  });
});
