import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLengthFixPrompt, buildUserPrompt, formatOutlineForPrompt } from '../../src/lib/script/generate-script.ts';
import {
  buildOutlinePrompt,
  generateOutline,
  mergeBriefFacts,
  normalizeOutline,
  trimBrief,
  MAX_BRIEF_CHARS,
  type ScriptOutline,
} from '../../src/lib/script/outline.ts';
import { composeDescription, descriptionSources } from '../../src/pipeline/publish/metadata.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import type { ResearchDossier } from '../../src/lib/research/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const dossier: ResearchDossier = {
  topic: 'Balotelli',
  provider: 'wikipedia',
  createdAt: '2026-10-22T00:00:00Z',
  sources: [
    { id: 'S1', title: 'Mario Balotelli', url: 'https://en.wikipedia.org/wiki/Mario_Balotelli' },
    { id: 'S2', title: 'Manchester City F.C.', url: 'https://en.wikipedia.org/wiki/Manchester_City_F.C.' },
  ],
  facts: [
    { id: 'F1', claim: 'Balotelli joined Manchester City in August 2010.', sourceIds: ['S1'] },
    { id: 'F2', claim: 'City won the 2011-12 Premier League on goal difference.', sourceIds: ['S2'] },
  ],
};

const outline: ScriptOutline = {
  hook: 'A T-shirt that asked the world one question.',
  chapters: [
    { title: 'The Boy from Palermo', points: ['Born to Ghanaian parents', 'Fostered in Brescia'] },
    { title: 'Why Always Me?', points: ['The derby goal and the shirt'], fact_ids: ['F1'] },
  ],
  closing: 'Why always him? Maybe because he let us watch.',
};

describe('Brief mode', () => {
  it('puts the brief and the approved outline in the script prompt, and keeps them in length passes', () => {
    const input = {
      topic: 'Balotelli',
      style: 'sport' as const,
      targetMinutes: 8,
      research: dossier,
      brief: 'Open with the "Why Always Me?" shirt. End on: "Maybe because he let us watch."',
      outline,
    };
    const prompt = buildUserPrompt(input);
    assert.match(prompt, /CREATOR'S BRIEF/);
    assert.match(prompt, /Open with the "Why Always Me\?" shirt/);
    assert.match(prompt, /APPROVED OUTLINE/);
    assert.match(prompt, /2\. Why Always Me\? \[facts: F1\]\n   - The derby goal and the shirt/);
    assert.match(prompt, /Word budget/);
    assert.match(prompt, /RESEARCH DOSSIER/);

    const lengthFix = buildLengthFixPrompt(input, { title_options: ['t'], beats: [] }, { min: 100, max: 120, target: 110, targetBeats: 5 } as never);
    assert.match(lengthFix, /APPROVED OUTLINE/);
  });

  it('leaves the prompt unchanged without a brief', () => {
    const prompt = buildUserPrompt({ topic: 'Balotelli', style: 'sport', targetMinutes: 8, research: dossier });
    assert.doesNotMatch(prompt, /CREATOR'S BRIEF|APPROVED OUTLINE/);
  });

  it('formats the outline with hook, numbered chapters and closing', () => {
    const text = formatOutlineForPrompt(outline);
    assert.equal(text.split('\n')[0], 'Hook: A T-shirt that asked the world one question.');
    assert.match(text, /^1\. The Boy from Palermo$/m);
    assert.match(text, /^Closing: /m);
  });

  it('tidies outlines: drops empty chapters and points, unknown fact ids', () => {
    const clean = normalizeOutline(
      {
        hook: ' Hook ',
        chapters: [
          { title: '  Rise  ', points: ['a', '', '  ', 'a', 'b'], fact_ids: ['F1', 'F9'] },
          { title: '', points: ['', ' '] },
        ],
        closing: ' End ',
      },
      new Set(['F1', 'F2']),
    );
    assert.deepEqual(clean, { hook: 'Hook', chapters: [{ title: 'Rise', points: ['a', 'b'], fact_ids: ['F1'] }], closing: 'End' });
  });

  it("adds the brief's own facts to the research so the script can cite them", () => {
    const merged = mergeBriefFacts(dossier, 'Balotelli', ['He wore a "Why Always Me?" shirt in October 2011.', ''])!;
    assert.equal(merged.facts.length, 3);
    assert.deepEqual(merged.facts[2], { id: 'B1', claim: 'He wore a "Why Always Me?" shirt in October 2011.', sourceIds: ['brief'] });
    assert.equal(merged.sources.at(-1)?.url, '');
    assert.equal(dossier.facts.length, 2, 'the original dossier is not changed');

    const fromNothing = mergeBriefFacts(null, 'Balotelli', ['A fact.'])!;
    assert.equal(fromNothing.provider, 'brief');
    assert.equal(mergeBriefFacts(null, 'Balotelli', []), null);
  });

  it('caps runaway briefs', () => {
    assert.equal(trimBrief('x'.repeat(MAX_BRIEF_CHARS + 50)).length, MAX_BRIEF_CHARS);
    assert.equal(trimBrief('  a\r\nb  '), 'a\nb');
    assert.equal(trimBrief(undefined), '');
  });

  it('asks the outline model to follow the brief and cite researched facts', () => {
    const prompt = buildOutlinePrompt({ topic: 'Balotelli', style: 'sport', targetMinutes: 10, brief: 'Chapter 1: Palermo', research: dossier });
    assert.match(prompt, /CREATOR'S BRIEF:\n"""\nChapter 1: Palermo\n"""/);
    assert.match(prompt, /F2: City won/);
    assert.match(prompt, /about 8 chapters that build/);
    assert.match(prompt, /Never invent specifics/);
  });

  it('drafts an outline, merging brief facts and keeping the extras for publishing', async () => {
    const prompts: string[] = [];
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock-outline-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async (req) => {
        prompts.push(req.prompt);
        return {
          data: {
            hook: 'Hook',
            chapters: [{ title: 'One', points: ['p'], fact_ids: ['F1', 'B1', 'F77'] }],
            closing: 'End',
            brief_facts: ['He scored twice in the 6-1 derby win on 23 October 2011.'],
            title_ideas: ['Why Always Him?'],
            thumbnail_ideas: ['Balotelli lifting his shirt, text WHY ME?'],
            sources: ['BBC Sport, 23 Oct 2011', 'BBC Sport, 23 Oct 2011'],
          },
          usage: {},
        } as never;
      },
    };
    registerProvider('llm', 'mock-outline-llm', llm);
    const { supabase } = createMockSupabase({
      yt_provider_configs: [{ id: 'cfg-outline', kind: 'llm', provider: 'mock-outline-llm', label: 'Outline', is_active: true }],
      yt_stage_bindings: [{ stage: 'script', provider_config_id: 'cfg-outline', max_retries: 0 }],
    });

    const result = await generateOutline(supabase, { topic: 'Balotelli', style: 'sport', targetMinutes: 10, brief: 'notes', research: dossier });
    assert.equal(prompts.length, 1);
    assert.deepEqual(result.outline.chapters[0].fact_ids, ['F1', 'B1'], 'brief facts are citable; unknown ids are dropped');
    assert.equal(result.research?.facts.at(-1)?.id, 'B1');
    assert.deepEqual(result.extras, {
      title_ideas: ['Why Always Him?'],
      thumbnail_ideas: ['Balotelli lifting his shirt, text WHY ME?'],
      sources: ['BBC Sport, 23 Oct 2011'],
    });
  });

  it('lists sources in the description: the creator\'s, then the cited research', () => {
    const research = mergeBriefFacts(dossier, 'Balotelli', ['A brief fact.'])!;
    const sj = {
      brief: 'notes',
      brief_extras: { sources: ['- BBC Sport: https://bbc.co.uk/sport/x', 'https://en.wikipedia.org/wiki/Mario_Balotelli'] },
      beats: [{ fact_ids: ['F1'] }, { fact_ids: ['B1'] }],
      research,
    };
    // S1 is cited but already listed by the creator; S2 isn't cited; the brief has no link
    assert.equal(descriptionSources(sj), '- BBC Sport: https://bbc.co.uk/sport/x\n- https://en.wikipedia.org/wiki/Mario_Balotelli');
    assert.equal(
      descriptionSources({ ...sj, brief_extras: { sources: [] }, beats: [{ fact_ids: ['F2'] }] }),
      '- Manchester City F.C.: https://en.wikipedia.org/wiki/Manchester_City_F.C.',
    );
    // Every researched video gets its cited sources; nothing without research or a brief
    assert.equal(
      descriptionSources({ beats: [{ fact_ids: ['F2'] }], research: dossier }),
      '- Manchester City F.C.: https://en.wikipedia.org/wiki/Manchester_City_F.C.',
    );
    assert.equal(descriptionSources({ beats: [{ fact_ids: [] }] }), '');

    const description = composeDescription({ hook: 'Hook.', summary: 'Summary.', chapters: '0:00 Intro', sources: '- A', credits: '- B' });
    assert.ok(description.indexOf('Chapters:') < description.indexOf('Sources:'));
    assert.ok(description.indexOf('Sources:') < description.indexOf('Credits:'));
  });
});
