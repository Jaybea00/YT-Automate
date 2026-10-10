import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeInputHash, computeScriptFingerprint, stableStringify } from '../../src/pipeline/utils/hash.ts';

describe('Pipeline Hashing & Fingerprinting', () => {
  it('stableStringify produces identical output regardless of object key order', () => {
    const objA = { b: 2, a: 1, c: { y: 'bar', x: 'foo' } };
    const objB = { a: 1, c: { x: 'foo', y: 'bar' }, b: 2 };

    assert.equal(stableStringify(objA), stableStringify(objB));
  });

  it('computeInputHash is deterministic regardless of options key ordering', () => {
    const hash1 = computeInputHash({
      stage: 'tts',
      input: { text: 'Hello world', voiceId: 'alloy' },
      providerId: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      options: { speed: 1.0, stability: 0.5 },
    });

    const hash2 = computeInputHash({
      stage: 'tts',
      input: { voiceId: 'alloy', text: 'Hello world' },
      providerId: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      options: { stability: 0.5, speed: 1.0 },
    });

    assert.equal(hash1, hash2);
  });

  it('computeInputHash changes when provider or model changes', () => {
    const baseInput = {
      stage: 'tts',
      input: { text: 'Hello world' },
      providerId: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      options: {},
    };

    const hashBase = computeInputHash(baseInput);

    const hashDifferentProvider = computeInputHash({
      ...baseInput,
      providerId: 'openai-compatible',
    });

    const hashDifferentModel = computeInputHash({
      ...baseInput,
      model: 'eleven_turbo_v2_5',
    });

    assert.notEqual(hashBase, hashDifferentProvider);
    assert.notEqual(hashBase, hashDifferentModel);
  });

  it('computeInputHash changes when scene input changes', () => {
    const hashScene1 = computeInputHash({
      stage: 'image',
      input: { prompt: 'A futuristic city skyline at dusk' },
      providerId: 'openai',
      model: 'dall-e-3',
    });

    const hashScene2 = computeInputHash({
      stage: 'image',
      input: { prompt: 'A medieval castle surrounded by mist' },
      providerId: 'openai',
      model: 'dall-e-3',
    });

    assert.notEqual(hashScene1, hashScene2);
  });

  it('computeScriptFingerprint detects changes in approved script', () => {
    const script1 = {
      title: 'AI History',
      scenes: [
        { scene_number: 1, narration: 'In 1950, Turing proposed...', visual_prompt: 'Turing machine' },
      ],
    };

    const script2 = {
      title: 'AI History',
      scenes: [
        { scene_number: 1, narration: 'In 1956, Dartmouth conference...', visual_prompt: 'Conference room' },
      ],
    };

    const fp1 = computeScriptFingerprint(script1);
    const fp2 = computeScriptFingerprint(script2);

    assert.notEqual(fp1, fp2);
  });
});
