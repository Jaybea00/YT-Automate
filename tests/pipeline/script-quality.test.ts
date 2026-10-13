import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countQuantities,
  estimateSpeechSeconds,
  normalizeBeats,
  wordBudgetForMinutes,
} from '../../src/lib/script/script-quality.ts';
import type { ScriptBeat } from '../../src/lib/script/generate-script.ts';

describe('Script quality rules', () => {
  it('derives a word budget from target minutes at the measured narration pace', () => {
    const budget = wordBudgetForMinutes(5);
    assert.equal(budget.target, 690);
    assert.equal(budget.min, 635);
    assert.equal(budget.max, 745);
    assert.equal(budget.targetBeats, 29);
  });

  it('estimates speech seconds from word count', () => {
    assert.equal(estimateSpeechSeconds('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree'), 10);
    assert.equal(estimateSpeechSeconds('Hi'), 1);
  });

  it('counts digit and spelled-out quantities', () => {
    assert.equal(countQuantities('The Dow climbed from about 64 in 1921 to 381'), 3);
    assert.equal(countQuantities('An unprecedented sixteen million shares were dumped'), 1);
    assert.equal(countQuantities('from 3 percent in 1929 to twenty-five percent by 1933'), 4);
    assert.equal(countQuantities('about $30 billion, ten times the federal budget'), 2);
    assert.equal(countQuantities('Confidence seemed unlimited.'), 0);
    assert.equal(countQuantities('Sixteen point four million shares changed hands'), 1);
    assert.equal(countQuantities('The point is that nobody sold.'), 0);
  });

  it('renumbers beats, drops empty ones, recomputes durations, and downgrades number-less charts', () => {
    const beats: ScriptBeat[] = [
      { index: 3, text: 'Confidence seemed unlimited.', visual_type: 'chart', visual_query: 'q', duration_estimate_seconds: 99 },
      { index: 7, text: '   ', visual_type: 'stock', visual_query: 'q', duration_estimate_seconds: 5 },
      { index: 9, text: 'Unemployment rose from 3 percent to 25 percent.', visual_type: 'chart', visual_query: ' q ', duration_estimate_seconds: 1 },
    ];

    const result = normalizeBeats(beats);

    assert.deepEqual(result.map((b) => b.index), [0, 1]);
    assert.equal(result[0].visual_type, 'stock');
    assert.equal(result[1].visual_type, 'chart');
    assert.equal(result[1].visual_query, 'q');
    assert.equal(result[0].duration_estimate_seconds, 1.3);
  });

  it('downgrades street-level maps but keeps city/country maps', () => {
    const beat = (visual_query: string): ScriptBeat => ({
      index: 0,
      text: 'It all happened within a few blocks.',
      visual_type: 'geo_map',
      visual_query,
      duration_estimate_seconds: 3,
    });
    const downgraded = normalizeBeats([beat('map: lower Manhattan New York')])[0];
    assert.equal(downgraded.visual_type, 'stock');
    assert.equal(downgraded.visual_query, 'lower Manhattan New York');
    assert.equal(normalizeBeats([beat('map: Broad Street, Wall Street')])[0].visual_type, 'stock');
    assert.equal(normalizeBeats([beat('map: New York -> London -> Berlin')])[0].visual_type, 'geo_map');
  });
});
