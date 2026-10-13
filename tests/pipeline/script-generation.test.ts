import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  generateScript,
  GeneratedScript,
  GeneratedScriptSchema,
  withWritingModel,
} from '../../src/lib/script/generate-script.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import { ProviderError } from '../../src/pipeline/providers/errors.ts';
import type { LLMProvider, ProviderCallContext } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';
import {
  GeminiLlmProvider,
  modelFallbackOrder,
  toGeminiResponseSchema,
} from '../../src/pipeline/providers/llm/gemini.ts';
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

    const result = await generateScript(
      supabase,
      { topic: 'Quantum Computing', style: 'tech', targetMinutes: 1 },
      { maxLengthPasses: 0 },
    );

    assert.equal(callCount, 1);
    assert.deepEqual(result.title_options, dummyScript.title_options);
    // Normalized: 0-based indexes, word-count durations, chart without numbers downgraded to stock
    assert.deepEqual(
      result.beats.map((b) => [b.index, b.visual_type, b.duration_estimate_seconds]),
      [
        [0, 'screen_recording', 3.5],
        [1, 'stock', 3.5],
      ],
    );
  });

  it('runs a length-correction pass when a fresh script misses its word budget', async () => {
    const longBeat = (i: number) => ({
      index: i,
      text: Array.from({ length: 23 }, (_, w) => `word${w}`).join(' '),
      visual_type: 'stock' as const,
      visual_query: 'city skyline',
      duration_estimate_seconds: 10,
    });
    // 1 minute = 138 words; 6 beats x 23 words = 138
    const inBudgetScript: GeneratedScript = {
      title_options: ['A', 'B', 'C'],
      beats: Array.from({ length: 6 }, (_, i) => longBeat(i)),
    };

    const prompts: string[] = [];
    const lengthLlm: LLMProvider = {
      kind: 'llm',
      id: 'mock-length-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async (req) => {
        prompts.push(req.prompt);
        return { data: prompts.length === 1 ? dummyScript : inBudgetScript, usage: {} } as any;
      },
    };
    registerProvider('llm', 'mock-length-llm', lengthLlm);

    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        { id: 'cfg-llm-length', kind: 'llm', provider: 'mock-length-llm', label: 'Length', is_active: true },
      ],
      yt_stage_bindings: [{ stage: 'script', provider_config_id: 'cfg-llm-length', max_retries: 0 }],
    });

    const result = await generateScript(supabase, { topic: 'Quantum', style: 'tech', targetMinutes: 1 });

    assert.equal(prompts.length, 2, 'Short first draft should trigger exactly one correction pass');
    assert.match(prompts[0], /Word budget for the narration: 127-149 words/);
    assert.match(prompts[1], /too short/);
    assert.equal(result.beats.length, 6);
  });

  it('does not length-correct revisions, so feedback like "make it shorter" is respected', async () => {
    let calls = 0;
    const reviseLlm: LLMProvider = {
      kind: 'llm',
      id: 'mock-revise-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => {
        calls++;
        return { data: dummyScript, usage: {} } as any;
      },
    };
    registerProvider('llm', 'mock-revise-llm', reviseLlm);

    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        { id: 'cfg-llm-revise', kind: 'llm', provider: 'mock-revise-llm', label: 'Revise', is_active: true },
      ],
      yt_stage_bindings: [{ stage: 'script', provider_config_id: 'cfg-llm-revise', max_retries: 0 }],
    });

    await generateScript(supabase, {
      topic: 'Quantum',
      style: 'tech',
      targetMinutes: 5,
      revisionOf: { previousScript: dummyScript, feedback: 'make it much shorter' },
    });

    assert.equal(calls, 1);
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

    const result = await generateScript(
      supabase,
      { topic: 'Quantum Computing', style: 'tech', targetMinutes: 1 },
      { maxLengthPasses: 0 },
    );

    assert.equal(callAttempts, 2, 'Should have succeeded on the second attempt after 1 retry');
    assert.equal(result.beats.length, dummyScript.beats.length);
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

  it('converts the script schema into a Gemini response schema for constrained JSON output', () => {
    const schema = toGeminiResponseSchema(GeneratedScriptSchema) as any;
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['title_options', 'beats']);
    const beat = schema.properties.beats.items;
    assert.equal(beat.properties.visual_type.format, 'enum');
    assert.ok(beat.properties.visual_type.enum.includes('newspaper'));
    assert.equal(beat.properties.duration_estimate_seconds.type, 'number');
  });

  it('falls back within the same model tier before crossing between lite and full models', () => {
    const order = modelFallbackOrder('gemini-3.8-flash');
    assert.equal(order[0], 'gemini-3.8-flash');
    assert.ok(order.indexOf('gemini-3.7-flash') < order.indexOf('gemini-3.5-flash-lite'));
    assert.equal(modelFallbackOrder('gemini-3.5-flash-lite')[1], 'gemini-flash-lite-latest');
  });

  it('uses the binding option writingModel for full-script writing only', () => {
    const ctx = { apiKey: 'k', model: 'gemini-3.5-flash-lite' };
    assert.equal(withWritingModel(ctx, { writingModel: 'gemini-3.8-flash' }).model, 'gemini-3.8-flash');
    assert.equal(withWritingModel(ctx, {}).model, 'gemini-3.5-flash-lite');
  });

  it('skips constrained output for schemas outside Gemini\'s supported subset', () => {
    assert.equal(toGeminiResponseSchema(z.object({ data: z.record(z.string(), z.number()) })), null);
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
