import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPronunciationPrompt,
  mergeHintsIntoList,
  normalizeHints,
  pronunciationCandidates,
  suggestPronunciations,
} from '../../src/lib/script/pronunciation-hints.ts';
import { toSpeakableText } from '../../src/pipeline/tts/speakable.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const texts = [
  'In Sarajevo, Nedeljko Čabrinović threw a bomb at the car.',
  "Gavrilo Princip's shot hit the archduke; Čabrinović swallowed cyanide.",
];

describe('Pronunciation hints', () => {
  it('collects capitalised and non-English words once, without short words, known terms or possessives', () => {
    const candidates = pronunciationCandidates(texts, [{ term: 'sarajevo', say: 'sa-ra-YAY-vo' }]);
    assert.deepEqual(candidates, ['Nedeljko', 'Čabrinović', 'Gavrilo', 'Princip']);
  });

  it('asks for respellings with stress in capitals, skipping names English voices already say well', () => {
    const prompt = buildPronunciationPrompt('The Sarajevo assassination', ['Čabrinović']);
    assert.match(prompt, /stressed syllable in CAPITALS/);
    assert.match(prompt, /Skip ordinary English words/);
    assert.match(prompt, /WORDS:\nČabrinović$/);
  });

  it('keeps hints only for words in the script, once each, with a real respelling', () => {
    const hints = normalizeHints(
      [
        { term: 'čabrinović', say: ' chah-BREE-noh-vich ', note: 'Serbian surname' },
        { term: 'Čabrinović', say: 'again' },
        { term: 'Princip', say: 'princip' },
        { term: 'Belgrade', say: 'BEL-grayd' },
        { term: 'Gavrilo', say: '' },
      ],
      ['Nedeljko', 'Čabrinović', 'Gavrilo', 'Princip'],
    );
    assert.deepEqual(hints, [{ term: 'Čabrinović', say: 'chah-BREE-noh-vich', note: 'Serbian surname' }]);
  });

  it('adds ticked hints to the list once, keeping existing entries and skipping unticked ones', () => {
    const merged = mergeHintsIntoList(
      [{ term: 'Gavrilo', say: 'GAV-ree-lo' }],
      [
        { term: 'Čabrinović', say: 'chah-BREE-noh-vich' },
        { term: 'gavrilo', say: 'ga-VREE-lo' },
        { term: 'Nedeljko', say: 'NED-el-ko', skip: true },
      ],
    );
    assert.equal(merged.added, 1);
    assert.deepEqual(merged.list, [
      { term: 'Gavrilo', say: 'GAV-ree-lo' },
      { term: 'Čabrinović', say: 'chah-BREE-noh-vich' },
    ]);
    assert.deepEqual(merged.hints.map((h) => Boolean(h.added)), [true, true, false]);
    // The respelling only changes what the voice reads
    assert.equal(toSpeakableText('Čabrinović threw a bomb.', merged.list), 'chah-BREE-noh-vich threw a bomb.');
  });

  it('skips the model when there is nothing to ask about', async () => {
    let calls = 0;
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock-pron-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => {
        calls++;
        return { data: { hints: [{ term: 'Čabrinović', say: 'chah-BREE-noh-vich' }] }, usage: {} } as never;
      },
    };
    registerProvider('llm', 'mock-pron-llm', llm);
    const { supabase } = createMockSupabase({
      yt_provider_configs: [{ id: 'cfg-pron', kind: 'llm', provider: 'mock-pron-llm', label: 'p', is_active: true }],
      yt_stage_bindings: [{ stage: 'script', provider_config_id: 'cfg-pron', max_retries: 0 }],
    });

    const none = await suggestPronunciations(supabase, 'topic', ['all lower case words here.'], []);
    assert.equal(calls, 0);
    assert.deepEqual(none.hints, []);

    const found = await suggestPronunciations(supabase, 'Sarajevo 1914', texts, []);
    assert.equal(calls, 1);
    assert.deepEqual(found.hints, [{ term: 'Čabrinović', say: 'chah-BREE-noh-vich' }]);
  });
});
