import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSubtitles, wrapCue } from '../../src/pipeline/utils/subtitles.ts';
import { readTimeline } from '../../src/pipeline/utils/timeline.ts';

const timed = (text: string, startSec = 0, step = 0.35) =>
  text.split(' ').map((word, i) => ({ word, start: startSec + i * step, end: startSec + i * step + 0.3 }));

describe('Subtitle files on the real timeline', () => {
  it('wraps a long cue into two balanced lines', () => {
    assert.equal(wrapCue('Short line.'), 'Short line.');
    assert.equal(
      wrapCue('Thousands of banks failed and businesses cut jobs across the country'),
      'Thousands of banks failed and\nbusinesses cut jobs across the country',
    );
  });

  it('starts each beat where its voice starts, not where the voice lengths add up to', () => {
    const r = generateSubtitles({
      beats: [{ index: 0, text: 'First beat.' }, { index: 1, text: 'Second beat.' }],
      units: [{ unit_index: 0, duration_ms: 2000 }, { unit_index: 1, duration_ms: 2000 }],
      // Lead-ins and the pause between beats put beat 1's voice at 2.85 s, not 2.0 s
      voiceStartMs: { 0: 200, 1: 2850 },
    });
    assert.deepEqual(r.cues.map((c) => c.startMs), [200, 2850]);
  });

  it('times cues to the narrator\'s words, breaking at sentence ends and pauses', () => {
    const words = [...timed('Black Tuesday came.'), ...timed('Then the banks failed, one after another', 1.6)];
    const r = generateSubtitles({
      beats: [{ index: 0, text: words.map((w) => w.word).join(' ') }],
      units: [{ unit_index: 0, duration_ms: 4500 }],
      voiceStartMs: { 0: 1000 },
      words: { 0: words },
    });
    assert.deepEqual(r.cues.map((c) => c.text), ['Black Tuesday came.', 'Then the banks failed, one after another']);
    assert.equal(r.cues[0].startMs, 1000);
    assert.equal(r.cues[1].startMs, 2600);
    assert.ok(r.cues[0].endMs <= r.cues[1].startMs, 'cues never overlap');
    assert.match(r.srt, /^1\n00:00:01,000 --> /);
  });

  it('keeps every cue on screen long enough to read', () => {
    const r = generateSubtitles({
      beats: [{ index: 0, text: 'Crash.' }, { index: 1, text: 'Panic followed.' }],
      units: [{ unit_index: 0, duration_ms: 400 }, { unit_index: 1, duration_ms: 900 }],
      voiceStartMs: { 0: 0, 1: 3000 },
      words: { 0: [{ word: 'Crash.', start: 0, end: 0.4 }] },
    });
    assert.equal(r.cues[0].endMs - r.cues[0].startMs, 1000);
  });

  it('reads only a saved timeline it understands', () => {
    assert.equal(readTimeline({}), null);
    assert.equal(readTimeline({ timeline: { version: 2, beats: [{}] } }), null);
    assert.ok(readTimeline({ timeline: { version: 1, renderedAt: '', totalMs: 1, beats: [{ index: 0 }] } }));
  });
});
