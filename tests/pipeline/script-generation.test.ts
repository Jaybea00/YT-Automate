import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateScript, GeneratedScript } from '../../src/lib/script/generate-script.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import { ProviderError } from '../../src/pipeline/providers/errors.ts';
import type { LLMProvider, ProviderCallContext } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';
import { GeminiLlmProvider } from '../../src/pipeline/providers/llm/gemini.ts';
import { AnthropicLlmProvider } from '../../src/pipeline/providers/llm/anthropic.ts';

describe('Part B: Script Generation via Registry & LLM Adapters', () => {
  const dummyScript: GeneratedScript = {
    title_options: [
      'The Future of Quantum Computing',
      'Quantum Breakthroughs Explained',
      'Why Quantum Matters',
    ],
    beats: [
      {
        index: 1,
        text: 'Quantum computers use qubits instead of classical bits.',
        visual_type: 'screen_recording',
        visual_query: 'quantum simulation in Jupyter notebook',
        duration_estimate_seconds: 6,
      },
      {
        index: 2,
        text: 'This graph shows exponential speedup in optimization tasks.',
        visual_type: 'chart',
        visual_query: 'quantum speedup chart',
        duration_estimate_seconds: 7,
      },
    ],
  };

  it('generateScript resolves provider from registry and returns validated script', async () => {
    let callCount = 0;
    const mockLlm: LLMProvider = {
      kind: 'llm',
      id: 'mock-llm-script',
      generateText: async () => ({ text: 'mock text', usage: {} }),
      generateJson: async () => {
        callCount++;
        return { data: dummyScript, usage: { inputTokens: 100, outputTokens: 200 } };
      },
    };

    registerProvider('llm', 'mock-llm-script', mockLlm);

    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        {
          id: 'cfg-llm-1',
          kind: 'llm',
          provider: 'mock-llm-script',
          label: 'Mock Script LLM',
          is_active: true,
          options: {},
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'script',
          provider_config_id: 'cfg-llm-1',
          model: 'gemini-3.8-flash',
          max_retries: 2,
        },
      ],
    });

    const result = await generateScript(supabase, {
      topic: 'Quantum Computing',
      style: 'tech',
      targetMinutes: 1,
    });

    assert.equal(callCount, 1);
    assert.deepEqual(result, dummyScript);
  });

  it('generateScript retries on transient errors (503/429) up to max_retries', async () => {
    let callAttempts = 0;
    const retryableMockLlm: LLMProvider = {
      kind: 'llm',
      id: 'mock-transient-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => {
        callAttempts++;
        if (callAttempts === 1) {
          throw new ProviderError('Server temporarily overloaded (503)', { code: 'transient' });
        }
        return { data: dummyScript, usage: {} };
      },
    };

    registerProvider('llm', 'mock-transient-llm', retryableMockLlm);

    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        {
          id: 'cfg-llm-transient',
          kind: 'llm',
          provider: 'mock-transient-llm',
          label: 'Mock Transient LLM',
          is_active: true,
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'script',
          provider_config_id: 'cfg-llm-transient',
          model: 'gemini-3.8-flash',
          max_retries: 2,
        },
      ],
    });

    const result = await generateScript(supabase, {
      topic: 'Quantum Computing',
      style: 'tech',
      targetMinutes: 1,
    });

    assert.equal(callAttempts, 2, 'Should have succeeded on the second attempt after 1 retry');
    assert.deepEqual(result, dummyScript);
  });

  it('fails fast on non-retryable errors without retrying', async () => {
    let callAttempts = 0;
    const authFailLlm: LLMProvider = {
      kind: 'llm',
      id: 'mock-auth-fail-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => {
        callAttempts++;
        throw new ProviderError('Invalid API key (401)', { code: 'auth' });
      },
    };

    registerProvider('llm', 'mock-auth-fail-llm', authFailLlm);

    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        {
          id: 'cfg-llm-auth',
          kind: 'llm',
          provider: 'mock-auth-fail-llm',
          label: 'Auth Fail LLM',
          is_active: true,
        },
      ],
      yt_stage_bindings: [
        {
          stage: 'script',
          provider_config_id: 'cfg-llm-auth',
          model: 'gemini-3.8-flash',
          max_retries: 3,
        },
      ],
    });

    await assert.rejects(
      async () => {
        await generateScript(supabase, {
          topic: 'Quantum Computing',
          style: 'tech',
          targetMinutes: 1,
        });
      },
      (err: any) => {
        assert.equal(err.code, 'auth');
        return true;
      },
    );

    assert.equal(callAttempts, 1, 'Auth errors must fail fast with zero retries');
  });

  it('Gemini adapter exposes LLMProvider interface with kind=llm', () => {
    const gemini = new GeminiLlmProvider();
    assert.equal(gemini.kind, 'llm');
    assert.equal(gemini.id, 'gemini');
    assert.equal(gemini.requiresApiKey, true);
    assert.equal(typeof gemini.generateText, 'function');
    assert.equal(typeof gemini.generateJson, 'function');
  });

  it('Anthropic adapter exposes LLMProvider interface with kind=llm', () => {
    const anthropic = new AnthropicLlmProvider();
    assert.equal(anthropic.kind, 'llm');
    assert.equal(anthropic.id, 'anthropic');
    assert.equal(anthropic.requiresApiKey, true);
    assert.equal(typeof anthropic.generateText, 'function');
    assert.equal(typeof anthropic.generateJson, 'function');
  });
});
