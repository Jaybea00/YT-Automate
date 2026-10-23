import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adCheckOrLocal,
  adCheckScript,
  buildAdCheckPrompt,
  findProfanity,
  mergeWithProfanity,
  normalizeAdIssues,
} from '../../src/lib/script/ad-check.ts';
import { openIssues } from '../../src/lib/script/fact-check-issues.ts';
import type { ScriptBeat } from '../../src/lib/script/generate-script.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const beat = (index: number, text: string): ScriptBeat => ({
  index,
  text,
  visual_type: 'stock',
  visual_query: 'q',
  duration_estimate_seconds: 8,
});

const beats = [
  beat(0, 'What the hell happened on that night in 1888?'),
  beat(1, 'The killer cut her throat and removed her organs with surgical skill.'),
  beat(2, 'Police later called it a shitshow from start to finish, and the press agreed.'),
];

function setup(id: string, respond: (prompt: string) => unknown) {
  const llm: LLMProvider = {
    kind: 'llm',
    id,
    generateText: async () => ({ text: '', usage: {} }),
    generateJson: async (req) => ({ data: respond(req.prompt), usage: {} }) as never,
  };
  registerProvider('llm', id, llm);
  return createMockSupabase({
    yt_provider_configs: [{ id: `cfg-${id}`, kind: 'llm', provider: id, label: id, is_active: true }],
    yt_stage_bindings: [{ stage: 'script', provider_config_id: `cfg-${id}`, max_retries: 0 }],
  }).supabase;
}

describe('Advertiser-friendly check', () => {
  it('finds strong swearing locally, strict in the opening seconds, ignoring mild words', () => {
    const issues = findProfanity(beats);
    assert.equal(issues.length, 1, '"hell" is fine; "shitshow" is not');
    assert.equal(issues[0].beat_index, 2);
    assert.equal(issues[0].severity, 'caution');

    const opening = findProfanity([beat(0, 'This is the fucking story nobody told.')]);
    assert.equal(opening[0].severity, 'limited');
    assert.match(opening[0].problem, /opening seconds/);
  });

  it('describes the guideline categories, keeps factual crime storytelling allowed, and checks titles', () => {
    const prompt = buildAdCheckPrompt(beats, ['Jack the Ripper: The Bloodiest Night'], 'true_crime');
    assert.match(prompt, /advertiser-friendly content guidelines/);
    assert.match(prompt, /Factual, non-graphic, educational storytelling about crime/);
    assert.match(prompt, /TITLES:\n- Jack the Ripper: The Bloodiest Night/);
    assert.match(prompt, /\[1\] The killer cut her throat/);
  });

  it('keeps one issue per beat and category, with known categories only', () => {
    const issues = normalizeAdIssues(
      [
        { beat_index: 1, category: 'Violence', severity: 'LIMITED', quote: 'cut her throat', problem: 'Graphic.', suggested_text: 'She was murdered.' },
        { beat_index: 1, category: 'violence', severity: 'caution', quote: 'organs', problem: 'Duplicate.' },
        { beat_index: 1, category: 'shocking', severity: 'maybe', quote: 'removed her organs', problem: 'Gory.' },
        { beat_index: 1, category: 'spoilers', severity: 'caution', quote: 'x', problem: 'Unknown.' },
        { beat_index: 7, category: 'violence', severity: 'caution', quote: 'x', problem: 'No beat.' },
      ],
      beats,
    );
    assert.deepEqual(
      issues.map((i) => [i.id, i.severity]),
      [
        ['ad-1-violence', 'limited'],
        ['ad-1-shocking', 'caution'],
      ],
    );
  });

  it('adds swearing the model missed and raises it in the opening seconds', () => {
    const opening = [beat(0, 'Shit. That was the first word on the tape.'), beats[1]];
    const merged = mergeWithProfanity(
      [{ id: 'ad-0-language', beat_index: 0, category: 'language', severity: 'caution', quote: 'Shit', problem: 'p', checked_text: opening[0].text }],
      opening,
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].severity, 'limited');
    assert.equal(mergeWithProfanity([], beats).length, 1);
  });

  it('checks titles once, keeps only real title options, and edited beats drop their issues', async () => {
    let calls = 0;
    const supabase = setup('mock-ad-llm', () => {
      calls++;
      return {
        issues: [{ beat_index: 1, category: 'violence', severity: 'limited', quote: 'cut her throat', problem: 'Graphic.' }],
        title_issues: [
          { title: 'Jack the Ripper: The Bloodiest Night', problem: 'Shocking word in title.', suggestion: 'Jack the Ripper: The Night London Changed' },
          { title: 'Not one of ours', problem: 'x' },
        ],
      };
    });
    const report = await adCheckScript(supabase, beats, ['Jack the Ripper: The Bloodiest Night'], 'true_crime');
    assert.equal(calls, 1);
    assert.deepEqual(report.issues.map((i) => i.id), ['ad-1-violence', 'ad-2-lang']);
    assert.equal(report.titleIssues.length, 1);
    assert.equal(openIssues(report, [{ index: 1, text: 'She was murdered that night.' }]).length, 0);
  });

  it('falls back to the local swearing check when the model fails', async () => {
    const supabase = setup('mock-ad-broken', () => {
      throw new Error('503');
    });
    const report = await adCheckOrLocal(supabase, beats, [], 'history');
    assert.equal(report.localOnly, true);
    assert.deepEqual(report.issues.map((i) => i.beat_index), [2]);
  });
});
