import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseGroundedFacts } from '../../src/lib/research/google-search.ts';
import { extractFactsFromArticles, selectArticles } from '../../src/lib/research/research.ts';
import { formatDossierForPrompt } from '../../src/lib/research/format.ts';
import { searchWikipediaCandidates, fetchWikipediaArticle } from '../../src/lib/research/wikipedia.ts';
import { applyResearchToBeats } from '../../src/lib/script/script-quality.ts';
import { buildUserPrompt, type ScriptBeat } from '../../src/lib/script/generate-script.ts';
import type { LLMProvider, ProviderCallContext } from '../../src/pipeline/providers/types.ts';
import {
  markModelBusy,
  modelFallbackOrder,
  resetModelCooldowns,
} from '../../src/pipeline/providers/llm/gemini.ts';
import type { ResearchDossier } from '../../src/lib/research/types.ts';

const ctx: ProviderCallContext = { apiKey: 'test' };

function mockLlm(respond: (prompt: string) => unknown): LLMProvider {
  return {
    kind: 'llm',
    id: 'mock-research',
    generateText: async () => ({ text: '', usage: {} }),
    generateJson: async (req) => ({ data: respond(req.prompt) as never, usage: {} }),
  };
}

const dossier: ResearchDossier = {
  topic: '1929 crash',
  provider: 'wikipedia',
  createdAt: '2026-10-13T00:00:00Z',
  sources: [{ id: 'S1', title: 'Wall Street crash of 1929', url: 'https://en.wikipedia.org/wiki/Wall_Street_crash_of_1929' }],
  facts: [
    { id: 'F1', claim: 'On Black Tuesday, around $14 billion of stock value was lost.', sourceIds: ['S1'] },
    { id: 'F2', claim: 'The Dow peaked at 381.17 on September 3, 1929.', sourceIds: ['S1'] },
  ],
};

describe('Research: Google Search grounding parser', () => {
  it('attaches sources to facts via grounding supports and drops unsupported facts', () => {
    const text = 'F1: Black Tuesday saw 16.4 million shares traded.\nF2: An unsupported claim.\nF3: The Dow closed at 41.22 in July 1932.';
    const result = parseGroundedFacts(text, {
      groundingChunks: [
        { web: { uri: 'https://a.example/crash', title: 'a.example' } },
        { web: { uri: 'https://b.example/dow', title: 'b.example' } },
        { web: { uri: 'https://a.example/crash', title: 'a.example' } },
      ],
      groundingSupports: [
        { segment: { text: 'Black Tuesday saw 16.4 million shares traded.' }, groundingChunkIndices: [0, 2] },
        { segment: { text: 'The Dow closed at 41.22 in July 1932.' }, groundingChunkIndices: [1] },
      ],
    });

    assert.deepEqual(result.facts.map((f) => [f.id, f.sourceIds]), [
      ['F1', ['S1']],
      ['F2', ['S2']],
    ]);
    assert.equal(result.sources.length, 2, 'duplicate URLs collapse into one source');
  });

  it('matches segments that keep the "F1:" label and drop the full stop (Gemini 3.8 Flash)', () => {
    const text = 'F1: Archduke Franz Ferdinand was the heir presumptive to the Austro-Hungarian throne.\nF2: **The assassination took place in Sarajevo on June 28, 1914.**';
    const result = parseGroundedFacts(text, {
      groundingChunks: [{ web: { uri: 'https://www.britannica.com/x', title: 'britannica.com' } }],
      groundingSupports: [
        { segment: { text: 'F1: Archduke Franz Ferdinand was the heir presumptive to the Austro-Hungarian throne' }, groundingChunkIndices: [0] },
        { segment: { text: 'F2: The assassination took place in Sarajevo on June 28, 1914' }, groundingChunkIndices: [0] },
      ],
    });
    assert.equal(result.facts.length, 2);
    assert.deepEqual(result.facts.map((f) => f.sourceIds), [['S1'], ['S1']]);
  });

  it('ignores tiny segments that would match unrelated facts', () => {
    const result = parseGroundedFacts('F1: The war began in 1914 after the assassination.', {
      groundingChunks: [{ web: { uri: 'https://a.example', title: 'a' } }],
      groundingSupports: [{ segment: { text: '1914' }, groundingChunkIndices: [0] }],
    });
    assert.equal(result.facts.length, 0);
  });
});

describe('Research: Wikipedia fact extraction', () => {
  it('keeps only facts citing a provided source and renumbers them', async () => {
    const llm = mockLlm(() => ({
      facts: [
        { claim: 'Black Thursday saw 12.9 million shares traded.', source_id: 'S1' },
        { claim: 'Invented fact from nowhere.', source_id: 'S9' },
        { claim: 'UK unemployment reached 3.5 million in 1932.', source_id: 'S2' },
      ],
    }));

    const { facts, sources } = await extractFactsFromArticles(llm, ctx, '1929 crash', [
      { title: 'Wall Street crash of 1929', url: 'https://w/1', text: '...' },
      { title: 'Great Depression in the United Kingdom', url: 'https://w/2', text: '...' },
      { title: 'Unused article', url: 'https://w/3', text: '...' },
    ]);

    assert.deepEqual(facts.map((f) => [f.id, f.sourceIds[0]]), [
      ['F1', 'S1'],
      ['F2', 'S2'],
    ]);
    assert.deepEqual(sources.map((s) => s.id), ['S1', 'S2'], 'uncited sources are dropped');
  });

  it('selectArticles only accepts listed titles and falls back to search order', async () => {
    const candidates = Array.from({ length: 7 }, (_, i) => ({ title: `T${i}`, snippet: '' }));
    const picky = mockLlm(() => ({ titles: ['T3', 'Not a candidate', 'T1'] }));
    assert.deepEqual(await selectArticles(picky, ctx, 'x', candidates), ['T3', 'T1']);

    const broken: LLMProvider = { ...picky, generateJson: async () => { throw new Error('down'); } };
    assert.deepEqual(await selectArticles(broken, ctx, 'x', candidates), ['T0', 'T1', 'T2', 'T3', 'T4']);
  });
});

describe('Research: Wikipedia API client', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('skips disambiguation pages and stubs, and strips reference sections', async () => {
    globalThis.fetch = (async (url: string) => {
      const body = String(url).includes('list=search')
        ? {
            query: {
              search: [
                { title: 'Wall Street Crash (disambiguation)', wordcount: 95, snippet: 'may refer to' },
                { title: 'Tiny stub', wordcount: 40, snippet: '' },
                { title: 'Wall Street crash of 1929', wordcount: 6111, snippet: 'The <span>Great</span> Crash' },
              ],
            },
          }
        : {
            query: {
              pages: [
                {
                  title: 'Wall Street crash of 1929',
                  fullurl: 'https://en.wikipedia.org/wiki/Wall_Street_crash_of_1929',
                  extract: 'Body text.\n== References ==\nCitation noise',
                },
              ],
            },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const candidates = await searchWikipediaCandidates('crash');
    assert.deepEqual(candidates, [{ title: 'Wall Street crash of 1929', snippet: 'The Great Crash' }]);

    const article = await fetchWikipediaArticle('Wall Street crash of 1929');
    assert.equal(article?.text, 'Body text.');
  });
});

describe('Research: script integration', () => {
  it('puts the dossier and its rules into the writing prompt', () => {
    const prompt = buildUserPrompt({ topic: '1929 crash', style: 'story_driven', targetMinutes: 5, research: dossier });
    assert.match(prompt, /RESEARCH DOSSIER/);
    assert.match(prompt, /F1: On Black Tuesday, around \$14 billion/);
    assert.match(prompt, /fact_ids/);
    assert.ok(formatDossierForPrompt(dossier).includes('F2: The Dow peaked at 381.17'));
  });

  it('keeps known fact ids and flags beats with unsupported numbers or quotes', () => {
    const beat = (text: string, fact_ids?: string[]): ScriptBeat => ({
      index: 0,
      text,
      visual_type: 'stock',
      visual_query: 'q',
      duration_estimate_seconds: 3,
      fact_ids,
    });

    const [backed, invented, quote, general] = applyResearchToBeats(
      [
        beat('About $14 billion vanished on Black Tuesday.', ['F1', 'F99']),
        beat('Thirty billion dollars vanished before lunch.', []),
        beat('Experts called it "a permanently high plateau" that autumn.'),
        beat('Nobody saw what was coming next.'),
      ],
      dossier,
    );

    assert.deepEqual(backed.fact_ids, ['F1']);
    assert.equal(backed.needs_check, false);
    assert.equal(invented.needs_check, true);
    assert.equal(quote.needs_check, true);
    assert.equal(general.needs_check, false);
  });

  it('turns newspaper beats into archive unless a cited fact quotes a headline', () => {
    const withHeadline: ResearchDossier = {
      ...dossier,
      facts: [...dossier.facts, { id: 'F3', claim: 'Variety ran the headline "Wall St. Lays an Egg".', sourceIds: ['S1'] }],
    };
    const newspaper = (fact_ids: string[]): ScriptBeat => ({
      index: 0,
      text: 'The papers summed it up in five words.',
      visual_type: 'newspaper',
      visual_query: 'Variety | Oct 30 1929 | Wall St. Lays an Egg',
      duration_estimate_seconds: 3,
      fact_ids,
    });

    assert.equal(applyResearchToBeats([newspaper(['F3'])], withHeadline)[0].visual_type, 'newspaper');
    const downgraded = applyResearchToBeats([newspaper(['F1'])], withHeadline)[0];
    assert.equal(downgraded.visual_type, 'archive');
    assert.equal(downgraded.visual_query, 'Variety Oct 30 1929 Wall St. Lays an Egg');
    assert.equal(
      applyResearchToBeats([newspaper(['F1'])], withHeadline, { enforceVisualRules: false })[0].visual_type,
      'newspaper',
      'review-page edits never override the chosen type',
    );
  });
});

describe('Gemini busy-model cooldown', () => {
  afterEach(() => resetModelCooldowns());

  it('moves a model that just reported overload to the back of the order', () => {
    const now = 1_000_000;
    markModelBusy('gemini-3.8-flash', now);
    const order = modelFallbackOrder('gemini-3.8-flash', now);
    assert.notEqual(order[0], 'gemini-3.8-flash');
    assert.equal(order[order.length - 1], 'gemini-3.8-flash');
    assert.equal(modelFallbackOrder('gemini-3.8-flash', now + 11 * 60 * 1000)[0], 'gemini-3.8-flash', 'cooldown expires');
  });
});
