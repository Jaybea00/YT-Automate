import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRegistry,
  getProvider,
  registerProvider,
  resolveForStage,
} from '../../src/pipeline/providers/registry.ts';
import { ConfigurationError } from '../../src/pipeline/providers/errors.ts';
import type { TTSProvider } from '../../src/pipeline/providers/types.ts';
import { openAiCompatTts } from '../../src/pipeline/providers/tts/openai-compatible.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

describe('Provider Registry & resolveForStage', () => {
  beforeEach(() => {
    clearRegistry();
  });

  const dummyTtsProvider: TTSProvider = {
    kind: 'tts',
    id: 'elevenlabs',
    requiresApiKey: true,
    synthesize: async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/mpeg',
      durationMs: 1200,
      usage: { characters: 10 },
    }),
  };

  it('registers and retrieves providers by kind and id', () => {
    registerProvider('tts', 'elevenlabs', dummyTtsProvider);
    const retrieved = getProvider('tts', 'elevenlabs');
    assert.ok(retrieved);
    assert.equal(retrieved?.id, 'elevenlabs');
    assert.equal(retrieved?.kind, 'tts');
  });

  it('resolves stage binding, merges options, and fetches vault secret', async () => {
    registerProvider('tts', 'elevenlabs', dummyTtsProvider);

    const providerConfigId = 'config-uuid-1';
    const secretId = 'secret-uuid-1';

    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        {
          id: providerConfigId,
          kind: 'tts',
          provider: 'elevenlabs',
          label: 'ElevenLabs Production',
          base_url: 'https://api.elevenlabs.io',
          default_model: 'eleven_multilingual_v2',
          secret_id: secretId,
          options: { speed: 1.0, stability: 0.5 },
          is_active: true,
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'tts',
          provider_config_id: providerConfigId,
          model: 'eleven_turbo_v2_5', // overrides default_model
          options: { speed: 1.15, voiceId: 'adam' }, // overrides speed, adds voiceId
          max_retries: 2,
        },
      ],
      vault_secrets: {
        [secretId]: 'sk_elevenlabs_test_secret_key',
      },
    });

    const resolved = await resolveForStage('tts', supabase);

    assert.equal(resolved.providerId, 'elevenlabs');
    assert.equal(resolved.maxRetries, 2);
    assert.equal(resolved.ctx.apiKey, 'sk_elevenlabs_test_secret_key');
    assert.equal(resolved.ctx.model, 'eleven_turbo_v2_5');
    assert.equal(resolved.ctx.baseUrl, 'https://api.elevenlabs.io');

    // Options merged: binding override config
    assert.deepEqual(resolved.ctx.options, {
      speed: 1.15,
      stability: 0.5,
      voiceId: 'adam',
    });
  });

  it('throws ConfigurationError if stage has no binding', async () => {
    const { supabase } = createMockSupabase();

    await assert.rejects(
      async () => {
        await resolveForStage('script', supabase);
      },
      (err: any) => {
        assert.ok(err instanceof ConfigurationError);
        assert.match(err.message, /No stage binding configured/);
        return true;
      },
    );
  });

  it('throws ConfigurationError if provider config is inactive', async () => {
    registerProvider('tts', 'elevenlabs', dummyTtsProvider);

    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        {
          id: 'config-1',
          kind: 'tts',
          provider: 'elevenlabs',
          label: 'Disabled Provider',
          is_active: false,
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'tts',
          provider_config_id: 'config-1',
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
        assert.match(err.message, /is inactive/);
        return true;
      },
    );
  });

  it('resolves openai-compatible TTS with requiresApiKey: false and null secret_id, and synthesizes audio', async () => {
    registerProvider('tts', 'openai-compatible', openAiCompatTts);

    const providerConfigId = 'kokoro-config-uuid';

    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        {
          id: providerConfigId,
          kind: 'tts',
          provider: 'openai-compatible',
          label: 'Kokoro (local, CPU — slow: ~9 min per sentence on this machine, do not assume a hung job is failed)',
          base_url: 'http://localhost:8880/v1',
          default_model: 'kokoro',
          secret_id: null,
          options: { voice: 'af_heart' },
          is_active: true,
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'tts',
          provider_config_id: providerConfigId,
          model: null,
          options: null,
          max_retries: 1,
        },
      ],
    });

    const resolved = await resolveForStage<TTSProvider>('tts', supabase);

    assert.equal(resolved.providerId, 'openai-compatible');
    assert.equal(resolved.provider.requiresApiKey, false);
    assert.equal(resolved.ctx.apiKey, '');
    assert.equal(resolved.ctx.baseUrl, 'http://localhost:8880/v1');
    assert.equal(resolved.ctx.model, 'kokoro');
    assert.deepEqual(resolved.ctx.options, { voice: 'af_heart' });

    // Mock global fetch to verify request details and ensure no real network call is made
    const originalFetch = globalThis.fetch;
    let interceptedUrl = '';
    let interceptedMethod = '';
    let interceptedHeaders: Record<string, string> | undefined;
    let interceptedBody: any = null;

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        // This fake server predates /dev/captioned_speech, so the provider falls back to plain speech
        if (String(input).endsWith('/dev/captioned_speech')) {
          return new Response('Not Found', { status: 404 });
        }
        interceptedUrl = String(input);
        interceptedMethod = init?.method || 'GET';
        interceptedHeaders = init?.headers as Record<string, string>;
        interceptedBody = init?.body ? JSON.parse(init.body as string) : null;

        const fakeAudioData = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00]); // ID3 dummy bytes
        return new Response(fakeAudioData, {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      };

      const result = await resolved.provider.synthesize(
        {
          text: 'Testing Kokoro TTS narration',
          voiceId: (resolved.ctx.options.voice as string) || 'af_heart',
          format: 'mp3',
        },
        resolved.ctx,
      );

      // Verify request target and method
      assert.equal(interceptedUrl, 'http://localhost:8880/v1/audio/speech');
      assert.equal(interceptedMethod, 'POST');

      // Verify no Authorization header is present when apiKey is empty
      assert.equal(interceptedHeaders?.Authorization, undefined);

      // Verify request payload matches OpenAI audio/speech spec
      assert.equal(interceptedBody.model, 'kokoro');
      assert.equal(interceptedBody.voice, 'af_heart');
      assert.equal(interceptedBody.input, 'Testing Kokoro TTS narration');
      assert.equal(interceptedBody.response_format, 'mp3');

      // Verify result shape matches ElevenLabs/TTSProvider contract
      assert.ok(result.bytes instanceof Uint8Array);
      assert.equal(result.bytes.length, 5);
      assert.equal(result.mimeType, 'audio/mpeg');
      assert.equal(result.usage.characters, 28);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('overrides stage binding when overrideConfigId is provided', async () => {
    const dummyElevenLabsProvider: TTSProvider = {
      kind: 'tts',
      id: 'elevenlabs',
      requiresApiKey: true,
      synthesize: async () => ({
        bytes: new Uint8Array([1]),
        mimeType: 'audio/mpeg',
        usage: { characters: 1 },
      }),
    };
    registerProvider('tts', 'elevenlabs', dummyElevenLabsProvider);
    registerProvider('tts', 'openai-compatible', openAiCompatTts);

    const elevenLabsConfigId = 'config-elevenlabs-id';
    const kokoroConfigId = 'config-kokoro-id';

    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        {
          id: elevenLabsConfigId,
          kind: 'tts',
          provider: 'elevenlabs',
          label: 'ElevenLabs Main',
          default_model: 'eleven_multilingual_v2',
          secret_id: 'secret-id-1',
          options: { voiceId: 'rachel' },
          is_active: true,
        },
        {
          id: kokoroConfigId,
          kind: 'tts',
          provider: 'openai-compatible',
          label: 'Kokoro Local',
          base_url: 'http://localhost:8880/v1',
          default_model: 'kokoro',
          secret_id: null,
          options: { voice: 'af_heart' },
          is_active: true,
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'tts',
          provider_config_id: elevenLabsConfigId,
          model: 'eleven_multilingual_v2',
          options: { voiceId: 'rachel' },
          max_retries: 2,
        },
      ],
      vault_secrets: {
        'secret-id-1': 'dummy-api-key',
      },
    });

    // 1. Without override -> resolves default bound config (ElevenLabs)
    const defaultResolved = await resolveForStage<TTSProvider>('tts', supabase);
    assert.equal(defaultResolved.providerId, 'elevenlabs');
    assert.equal(defaultResolved.configId, elevenLabsConfigId);

    // 2. With override -> resolves Kokoro
    const overriddenResolved = await resolveForStage<TTSProvider>('tts', supabase, kokoroConfigId);
    assert.equal(overriddenResolved.providerId, 'openai-compatible');
    assert.equal(overriddenResolved.configId, kokoroConfigId);
    assert.equal(overriddenResolved.model, 'kokoro');
    assert.equal(overriddenResolved.ctx.baseUrl, 'http://localhost:8880/v1');
    assert.deepEqual(overriddenResolved.ctx.options, { voice: 'af_heart' });
  });
});
