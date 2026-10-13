import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHooksPrompt,
  buildReviewPrompt,
  buildRewritePrompt,
  computeScriptMetrics,
  finalizeReview,
  generateHooks,
  metricWarnings,
  rewriteBeat,
  wordOverlap,
  type EditorContext,
} from '../../src/lib/script/script-editor.ts';
import { scriptTextSignature } from '../../src/lib/script/script-quality.ts';
import { STYLE_TEMPLATES, styleVoice } from '../../src/lib/script/style-templates.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import { ProviderError } from '../../src/pipeline/providers/errors.ts';
import type { ScriptBeat } from '../../src/lib/script/generate-script.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import type { ResearchDossier } from '../../src/lib/research/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const beat = (index: number, text: string, extra: Partial<ScriptBeat> = {}): ScriptBeat => ({
  index,
  text,
  visual_type: 'stock',
  visual_query: 'q',
  duration_estimate_seconds: 3,
  ...extra,
});

const research: ResearchDossier = {
  topic: '1929 crash',
  provider: 'wikipedia',
  createdAt: '2026-10-13T00:00:00Z',
  sources: [{ id: 'S1', title: 'Wall Street crash of 1929', url: 'https://w/1' }],
  facts: [{ id: 'F1', claim: 'On Black Tuesday, some 16.4 million shares were traded.', sourceIds: ['S1'] }],
};

const context: EditorContext = {
  topic: 'The 1929 crash',
  style: 'vox_explainer',
  research,
  targetMinutes: 1,
  beats: [
    beat(0, 'Tuesday, October 29, 1929. Sell orders bury the clerks on the floor.', { visual_type: 'archive' }),
    beat(1, 'By the closing bell, a record number of shares had changed hands.'),
    beat(2, 'Nobody on the floor could see the bottom yet, and the ticker kept falling behind.'),
  ],
};

function mockSupabaseWith(llm: LLMProvider) {
  registerProvider('llm', llm.id, llm);
  return createMockSupabase({
    yt_provider_configs: [{ id: `cfg-${llm.id}`, kind: 'llm', provider: llm.id, label: 'Editor', is_active: true }],
    yt_stage_bindings: [{ stage: 'script', provider_config_id: `cfg-${llm.id}`, max_retries: 0 }],
  }).supabase;
}

function llmReturning(id: string, data: unknown, prompts: string[] = []): LLMProvider {
  return {
    kind: 'llm',
    id,
    generateText: async () => ({ text: '', usage: {} }),
    generateJson: async (req) => {
      prompts.push(`${req.system}\n---\n${req.prompt}`);
      return { data: data as never, usage: {} };
    },
  };
}

describe('Vox explainer style', () => {
  it('is a registered style whose voice excludes the full-script output format', () => {
    assert.ok(STYLE_TEMPLATES.vox_explainer.systemPrompt.includes('Return the script as JSON only'));
    const voice = styleVoice('vox_explainer');
    assert.match(voice, /Vox and Johnny Harris/);
    assert.ok(!voice.includes('Return the script as JSON only'));
    assert.ok(!voice.includes('RETENTION CRAFT'));
  });
});

describe('Beat rewrite', () => {
  it('gives the model the whole script and the beat\'s neighbours', () => {
    const prompt = buildRewritePrompt(context, 1, 'Make it punchier');
    assert.match(prompt, /\[0\] Tuesday, October 29/);
    assert.match(prompt, /Rewrite beat \[1\] only/);
    assert.match(prompt, /flow from beat \[0\] and lead into beat \[2\]/);
    assert.match(prompt, /Instruction: Make it punchier/);
  });

  it('returns up to 3 variants checked like generated beats', async () => {
    const prompts: string[] = [];
    const supabase = mockSupabaseWith(
      llmReturning(
        'mock-rewrite',
        {
          variants: [
            { angle: 'Lead with the number', text: 'Sixteen point four million shares changed hands that day.', visual_type: 'chart', visual_query: 'q', fact_ids: ['F1'] },
            { angle: 'Invented figure', text: 'Twenty million shares vanished in one hour flat.', visual_type: 'stock', visual_query: 'q', fact_ids: [] },
            { angle: 'Map it', text: 'The panic spread down Wall Street and across lower Manhattan.', visual_type: 'geo_map', visual_query: 'map: lower Manhattan', fact_ids: null },
            { angle: 'Extra', text: 'A fourth variant that should be dropped.', visual_type: 'stock', visual_query: 'q' },
          ],
        },
        prompts,
      ),
    );

    const variants = await rewriteBeat(supabase, context, 1, 'Make it punchier');

    assert.equal(variants.length, 3);
    assert.ok(variants.every((v) => v.beat.index === 1));
    assert.equal(variants[0].beat.visual_type, 'stock', 'a chart needs two quantities');
    assert.deepEqual(variants[0].beat.fact_ids, ['F1']);
    assert.equal(variants[1].beat.needs_check, true, 'unsupported figure is flagged');
    assert.equal(variants[2].beat.visual_type, 'stock', 'street-level map downgraded');
    assert.match(prompts[0], /RESEARCH DOSSIER/);
    assert.match(prompts[0], /Vox and Johnny Harris/);
  });
});

describe('Hook lab', () => {
  it('asks for one hook per technique that leads into beat 1', () => {
    const prompt = buildHooksPrompt(context);
    for (const t of ['cold_open', 'shock_stat', 'question', 'contrarian']) assert.match(prompt, new RegExp(t));
    assert.match(prompt, /lead naturally into beat \[1\]/);
  });

  it('keeps one hook per technique, as beat 0', async () => {
    const supabase = mockSupabaseWith(
      llmReturning('mock-hooks', {
        hooks: [
          { technique: 'cold_open', text: 'The ticker is two hours behind, and men are screaming.', why_it_works: 'Mid-action.', visual_type: 'archive', visual_query: '1929 trading floor' },
          { technique: 'cold_open', text: 'Duplicate technique.', why_it_works: 'x', visual_type: 'stock', visual_query: 'q' },
          { technique: 'question', text: 'How do sixteen million shares change hands with no buyers?', why_it_works: 'Paradox.', visual_type: 'stock', visual_query: 'q', fact_ids: ['F1'] },
        ],
      }),
    );

    const hooks = await generateHooks(supabase, context);
    assert.deepEqual(hooks.map((h) => h.technique), ['cold_open', 'question']);
    assert.ok(hooks.every((h) => h.beat.index === 0));
  });

  it('drops a "hook" that is just a touch-up of the current one', async () => {
    const supabase = mockSupabaseWith(
      llmReturning('mock-hooks-copy', {
        hooks: [
          // Real output from a live run: the current hook with two words added
          { technique: 'cold_open', text: 'Tuesday, October 29, 1929. Desperate sell orders bury the clerks on the floor completely.', why_it_works: 'x', visual_type: 'archive', visual_query: 'q' },
          { technique: 'shock_stat', text: 'Sixteen point four million shares changed hands in a single day of panic.', why_it_works: 'Scale.', visual_type: 'stock', visual_query: 'q', fact_ids: ['F1'] },
        ],
      }),
    );
    const hooks = await generateHooks(supabase, context);
    assert.deepEqual(hooks.map((h) => h.technique), ['shock_stat']);
    assert.ok(wordOverlap(context.beats[0].text, context.beats[0].text) === 1);
  });
});

describe('Editor resilience', () => {
  it('retries a transient network failure instead of surfacing it', async () => {
    let calls = 0;
    const flaky: LLMProvider = {
      kind: 'llm',
      id: 'mock-flaky-editor',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => {
        calls++;
        if (calls === 1) throw new ProviderError('Network transient error: fetch failed', { code: 'transient' });
        return {
          data: { variants: [{ angle: 'A', text: 'A fresh take on the closing bell that day.', visual_type: 'stock', visual_query: 'q' }] } as never,
          usage: {},
        };
      },
    };
    const variants = await rewriteBeat(mockSupabaseWith(flaky), context, 1, 'Punchier');
    assert.equal(calls, 2);
    assert.equal(variants.length, 1);
  });
});

describe('Beat rewrite de-duplication', () => {
  it('collapses identical variants into one', async () => {
    const same = { text: 'It all happened within a few blocks of lower Manhattan.', visual_type: 'archive', visual_query: 'Broad Street 1929' };
    const supabase = mockSupabaseWith(
      llmReturning('mock-rewrite-dupes', {
        variants: [
          { angle: 'A', ...same },
          { angle: 'B', ...same },
          { angle: 'C', ...same, visual_query: 'J.P. Morgan building 1929' },
        ],
      }),
    );
    const variants = await rewriteBeat(supabase, context, 1, 'Use archive visuals');
    assert.deepEqual(variants.map((v) => v.angle), ['A', 'C']);
  });
});

describe('Script doctor', () => {
  it('measures runtime, hook length, and visual repetition', () => {
    const metrics = computeScriptMetrics(
      [beat(0, 'one two three four five'), beat(1, 'six seven eight nine ten'), beat(2, 'more words here', { visual_type: 'chart' })],
      1,
    );
    assert.equal(metrics.words, 13);
    assert.equal(metrics.hookWords, 5);
    assert.equal(metrics.longestSameVisualRun, 2);
    assert.equal(metrics.targetSeconds, 60);
    assert.equal(metrics.estimatedSeconds, Math.round(13 / 2.3 + 1.5) ); // speech + 3 x 0.5s pauses (rounded per beat)
    assert.match(buildReviewPrompt(context, metrics), /Longest run of the same visual type: 2 beats/);
  });

  it('clamps scores, drops duplicate dimensions and out-of-range beats, sorts issues by severity', () => {
    const review = finalizeReview(
      {
        overall: 11,
        summary: ' Strong facts, slow middle. ',
        scores: [
          { dimension: 'hook', score: 0, note: 'Opens on a date.' },
          { dimension: 'hook', score: 9, note: 'duplicate' },
          { dimension: 'pacing', score: 6.6, note: 'Middle drags.' },
        ],
        issues: [
          { beat_index: 2, severity: 'low', problem: 'Wordy', fix_instruction: 'Trim it' },
          { beat_index: 9, severity: 'high', problem: 'No such beat', fix_instruction: 'x' },
          { beat_index: 0, severity: 'high', problem: 'Weak hook', fix_instruction: 'Open on the shares figure' },
        ],
      },
      context.beats,
      computeScriptMetrics(context.beats, 1),
    );

    assert.equal(review.overall, 10);
    assert.equal(review.summary, 'Strong facts, slow middle.');
    assert.deepEqual(review.scores.map((s) => [s.dimension, s.score]), [['hook', 1], ['pacing', 7]]);
    assert.deepEqual(review.issues.map((i) => i.beatIndex), [0, 2]);
    assert.equal(review.basedOn, scriptTextSignature(context.beats));
  });

  it('adds measured warnings a lenient model review might gloss over', () => {
    const warnings = metricWarnings({
      words: 434,
      estimatedSeconds: 196,
      targetSeconds: 300,
      beats: 15,
      hookWords: 18,
      longestBeatSeconds: 16.1,
      longestSameVisualRun: 5,
      unverifiedBeats: 2,
    });
    assert.equal(warnings.length, 4);
    assert.match(warnings[0], /3:16 against a 5:00 target \(65%\)/);
    assert.deepEqual(metricWarnings({ ...computeScriptMetrics(context.beats), longestBeatSeconds: 5 }), []);
  });

  it('script signature changes when narration changes', () => {
    const edited = context.beats.map((b, i) => (i === 1 ? { ...b, text: `${b.text} Edited.` } : b));
    assert.notEqual(scriptTextSignature(edited), scriptTextSignature(context.beats));
    assert.equal(scriptTextSignature([...context.beats]), scriptTextSignature(context.beats));
  });
});
