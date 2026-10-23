import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPackagingPrompt,
  chosenPackage,
  generatePackaging,
  generatePackagingOrNull,
  leadWithPackageTitle,
  normalizePackaging,
} from '../../src/lib/script/packaging.ts';
import { sanitizePackaging } from '../../src/lib/script/packaging-types.ts';
import { buildUserPrompt } from '../../src/lib/script/generate-script.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const option = (title: string, extra: Record<string, string> = {}) => ({
  title,
  thumbnail_image: 'Balotelli lifting his shirt',
  thumbnail_text: 'WHY ME?',
  promise: 'Why the most gifted striker of his generation never became great.',
  angle: 'Curiosity',
  ...extra,
});

function setup(id: string, respond: () => unknown) {
  const llm: LLMProvider = {
    kind: 'llm',
    id,
    generateText: async () => ({ text: '', usage: {} }),
    generateJson: async () => ({ data: respond(), usage: {} }) as never,
  };
  registerProvider('llm', id, llm);
  return createMockSupabase({
    yt_provider_configs: [{ id: `cfg-${id}`, kind: 'llm', provider: id, label: id, is_active: true }],
    yt_stage_bindings: [{ stage: 'script', provider_config_id: `cfg-${id}`, max_retries: 0 }],
  }).supabase;
}

describe('Packaging first', () => {
  it('asks for honest title and thumbnail pairs, using the brief and the facts', () => {
    const prompt = buildPackagingPrompt({
      topic: 'Balotelli',
      style: 'sport',
      targetMinutes: 10,
      brief: 'Title idea: Why Always Him?',
      research: { topic: 'b', provider: 'wikipedia', createdAt: '', sources: [], facts: [{ id: 'F1', claim: 'City won 6-1.', sourceIds: [] }] },
    });
    assert.match(prompt, /Title idea: Why Always Him\?/);
    assert.match(prompt, /- City won 6-1\./);
    assert.match(prompt, /Never promise what the facts can't deliver/);
  });

  it('drops titles that are too long, repeated, or state figures the research lacks', () => {
    const options = normalizePackaging(
      [
        option('"Why Always Him?"'),
        option('why always him?'),
        option('x'.repeat(120)),
        option('The 6-1 Night That Made Balotelli'),
        option('The £50 Million Mistake'),
      ],
      'Manchester City won 6-1 at Old Trafford.',
    );
    assert.deepEqual(options.map((o) => o.title), ['Why Always Him?', 'The 6-1 Night That Made Balotelli']);
    assert.equal(options[0].angle, 'curiosity');
  });

  it('puts the packaged title first among the title options, without repeating it', () => {
    const pkg = chosenPackage({ options: [option('Why Always Him?')], chosen: 0 });
    assert.deepEqual(leadWithPackageTitle(['A', 'why always him?', 'B'], pkg), ['Why Always Him?', 'A', 'B']);
    assert.deepEqual(leadWithPackageTitle(['A'], null), ['A']);
  });

  it('writes the script to deliver the promise', () => {
    const prompt = buildUserPrompt({
      topic: 'Balotelli',
      style: 'sport',
      targetMinutes: 10,
      packaging: option('Why Always Him?'),
    });
    assert.match(prompt, /PACKAGING .*keep this promise/);
    assert.match(prompt, /Title: Why Always Him\?/);
    assert.match(prompt, /with the text "WHY ME\?"/);
    assert.match(prompt, /answer it clearly/);
    assert.doesNotMatch(buildUserPrompt({ topic: 'Balotelli', style: 'sport', targetMinutes: 10 }), /PACKAGING/);
  });

  it('cleans packaging sent from the outline page and keeps the choice in range', () => {
    assert.equal(sanitizePackaging(null), null);
    assert.equal(sanitizePackaging({ options: [{ title: '  ' }] }), null);
    const clean = sanitizePackaging({ options: [option('  Why   Always Him? '), { title: 'Second' }], chosen: 5 })!;
    assert.equal(clean.chosen, 0);
    assert.equal(clean.options[0].title, 'Why Always Him?');
    assert.equal(clean.options[1].thumbnail_image, '');
    assert.equal(sanitizePackaging({ options: [option('A'), option('B')], chosen: 1 })!.chosen, 1);
  });

  it('chooses the first option and never blocks the script when packaging fails', async () => {
    const ok = setup('mock-pack-llm', () => ({ options: [option('Why Always Him?'), option('The Golden Boy')] }));
    const packaging = await generatePackaging(ok, { topic: 'Balotelli', style: 'sport', targetMinutes: 10 });
    assert.equal(packaging?.chosen, 0);
    assert.equal(packaging?.options.length, 2);

    const broken = setup('mock-pack-broken', () => {
      throw new Error('429');
    });
    assert.equal(await generatePackagingOrNull(broken, { topic: 'Balotelli', style: 'sport', targetMinutes: 10 }), null);
  });
});
