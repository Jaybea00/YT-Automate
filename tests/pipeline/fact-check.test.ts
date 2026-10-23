import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFactCheckPrompt,
  checkerContext,
  factCheckOrNull,
  factCheckScript,
  normalizeIssues,
  openIssues,
} from '../../src/lib/script/fact-check.ts';
import type { ScriptBeat } from '../../src/lib/script/generate-script.ts';
import type { ResearchDossier } from '../../src/lib/research/types.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const beat = (index: number, text: string, fact_ids: string[] = []): ScriptBeat => ({
  index,
  text,
  visual_type: 'stock',
  visual_query: 'q',
  duration_estimate_seconds: 8,
  fact_ids,
});

const beats = [
  beat(0, 'In 2011 he scored twice as City won 6-1 at Old Trafford.', ['F1']),
  beat(1, 'Months later he was arrested for fireworks in his bathroom.'),
];

const dossier: ResearchDossier = {
  topic: 'Balotelli',
  provider: 'wikipedia',
  createdAt: '2026-10-22T00:00:00Z',
  sources: [{ id: 'S1', title: 'Mario Balotelli', url: 'https://en.wikipedia.org/wiki/Mario_Balotelli' }],
  facts: [{ id: 'F1', claim: 'Balotelli scored twice in a 6-1 win at Old Trafford on 23 October 2011.', sourceIds: ['S1'] }],
};

function setup(id: string, respond: (prompt: string) => unknown, options: Record<string, unknown> = {}) {
  const prompts: string[] = [];
  const models: Array<string | undefined> = [];
  const llm: LLMProvider = {
    kind: 'llm',
    id,
    generateText: async () => ({ text: '', usage: {} }),
    generateJson: async (req, ctx) => {
      prompts.push(req.prompt);
      models.push(ctx.model);
      return { data: respond(req.prompt), usage: {} } as never;
    },
  };
  registerProvider('llm', id, llm);
  const { supabase } = createMockSupabase({
    yt_provider_configs: [{ id: `cfg-${id}`, kind: 'llm', provider: id, label: id, is_active: true, model: 'gemini-lite' }],
    yt_stage_bindings: [{ stage: 'script', provider_config_id: `cfg-${id}`, max_retries: 0, options }],
  });
  return { supabase, prompts, models };
}

describe('Fact-check', () => {
  it('shows the checker every beat with its cited facts and source titles', () => {
    const prompt = buildFactCheckPrompt(beats, dossier);
    assert.match(prompt, /\[0\] \(cites F1\) In 2011/);
    assert.match(prompt, /\[1\] Months later/);
    assert.match(prompt, /F1: Balotelli scored twice .* \[Mario Balotelli\]/);
    assert.match(prompt, /"living_person"/);
    assert.match(prompt, /even when a fact supports them/);
  });

  it('without research, judges from established knowledge and skips "unsupported"', () => {
    assert.match(buildFactCheckPrompt(beats, null), /There is no research for this script/);
  });

  it('keeps real issues only: known beats and kinds, no duplicates, no no-op suggestions', () => {
    const issues = normalizeIssues(
      [
        { beat_index: 1, kind: 'Living Person', claim: 'arrested', problem: 'Damaging claim.', suggested_text: 'x', person: 'Mario Balotelli' },
        { beat_index: 1, kind: 'living_person', claim: 'Arrested', problem: 'Duplicate.' },
        { beat_index: 0, kind: 'distorted', claim: '2011', problem: 'Fine.', suggested_text: beats[0].text },
        { beat_index: 9, kind: 'unsupported', claim: 'x', problem: 'No such beat.' },
        { beat_index: 0, kind: 'opinion', claim: 'x', problem: 'Unknown kind.' },
        { beat_index: 0, kind: 'unsupported', claim: 'x', problem: '  ' },
      ],
      beats,
    );
    assert.equal(issues.length, 2);
    assert.deepEqual(issues[0], {
      id: 'fc-1-1',
      beat_index: 1,
      kind: 'living_person',
      claim: 'arrested',
      problem: 'Damaging claim.',
      suggested_text: 'x',
      person: 'Mario Balotelli',
      checked_text: beats[1].text,
    });
    assert.equal(issues[1].suggested_text, undefined, 'a suggestion identical to the beat is dropped');
  });

  it('hides dismissed issues and issues on beats edited since the check', () => {
    const report = {
      checkedAt: '',
      beatsChecked: 2,
      hadResearch: true,
      issues: normalizeIssues(
        [
          { beat_index: 0, kind: 'distorted', claim: 'a', problem: 'p' },
          { beat_index: 1, kind: 'unsupported', claim: 'b', problem: 'p' },
        ],
        beats,
      ),
    };
    assert.equal(openIssues(report, beats).length, 2);
    report.issues[0].dismissed = true;
    assert.deepEqual(openIssues(report, beats).map((i) => i.beat_index), [1]);
    assert.equal(openIssues(report, [beats[0], { ...beats[1], text: 'Edited.' }]).length, 0);
    assert.deepEqual(openIssues(undefined, beats), []);
  });

  it('uses factCheckModel when set, otherwise the base model rather than the writing model', () => {
    const ctx = { apiKey: 'k', model: 'gemini-lite' };
    assert.equal(checkerContext(ctx, { writingModel: 'gemini-3.8-flash' }).model, 'gemini-lite');
    assert.equal(checkerContext(ctx, { factCheckModel: ' gemini-pro ' }).model, 'gemini-pro');
  });

  it('checks long scripts in parts and reports which model checked', async () => {
    const many = Array.from({ length: 70 }, (_, i) => beat(i, `Beat ${i}.`));
    const { supabase, prompts, models } = setup(
      'mock-factcheck-llm',
      (prompt) => ({
        issues: prompt.includes('[65] Beat 65.') ? [{ beat_index: 65, kind: 'unsupported', claim: 'Beat', problem: 'No source.' }] : [],
      }),
      { writingModel: 'gemini-3.8-flash' },
    );
    const report = await factCheckScript(supabase, many, dossier);
    assert.equal(prompts.length, 2);
    assert.ok(models.every((m) => m !== 'gemini-3.8-flash'), 'the checker is not the writer');
    assert.equal(report.beatsChecked, 70);
    assert.equal(report.hadResearch, true);
    assert.deepEqual(report.issues.map((i) => i.id), ['fc-65-1']);
  });

  it('never fails the script write when the check fails', async () => {
    const { supabase } = setup('mock-factcheck-broken', () => {
      throw new Error('429 quota');
    });
    assert.equal(await factCheckOrNull(supabase, beats, dossier), null);
  });
});
