import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beatAt, buildWatchPrompt, MAX_AI_NOTES, misreadCaption, normalizeWatchNotes, type WatchContext } from '../../src/pipeline/vibedit/watch-through.ts';

const context: WatchContext = {
  title: 'You Won the Wrong Game',
  totalSec: 120,
  beats: [
    { index: 0, startSec: 0, voiceStartSec: 0.2, text: 'You finally got it.' },
    { index: 1, startSec: 10, voiceStartSec: 10.2, text: 'And it felt like nothing.' },
    { index: 2, startSec: 30, voiceStartSec: 30.5, text: 'Psychologists call this the arrival fallacy.' },
  ],
  chapters: [{ atSec: 30, title: 'The fallacy' }],
  endScreenSec: 12,
  captions: true,
};

describe('AI watch-through', () => {
  it('tells Gemini the lines with their times, the chapters and what is intended', () => {
    const p = buildWatchPrompt(context);
    assert.match(p, /\[0:30\] \(beat 3\) Psychologists call this the arrival fallacy\./);
    assert.match(p, /0:30 The fallacy/);
    assert.match(p, /last 12 seconds are an intended end screen/);
    assert.match(p, /Captions are burned in/);
    assert.match(p, /Freeze-frames with a short title/);
    assert.doesNotMatch(buildWatchPrompt({ ...context, endScreenSec: 0, captions: false }), /end screen/);
  });

  it('pins a moment to the beat playing then', () => {
    assert.equal(beatAt(context.beats, 0), 0);
    assert.equal(beatAt(context.beats, 9.9), 0);
    assert.equal(beatAt(context.beats, 10), 1);
    assert.equal(beatAt(context.beats, 119), 2);
  });

  it('keeps notes inside the video, one per moment and kind, worst first, then in order', () => {
    const notes = normalizeWatchNotes(
      [
        { at_sec: 50, kind: 'sound', severity: 'low', note: 'Music a touch loud.' },
        { at_sec: 12, kind: 'caption', severity: 'high', note: 'Captions cover the face.' },
        { at_sec: 13, kind: 'caption', severity: 'medium', note: 'Same caption problem again.' },
        { at_sec: 13, kind: 'pacing', severity: 'medium', note: 'Cut too quickly.' },
        { at_sec: 500, kind: 'glitch', severity: 'high', note: 'Black frame at the end.' },
        { at_sec: 5, kind: 'opening', severity: 'medium', note: '   ' },
      ],
      context,
    );
    assert.deepEqual(
      notes.map((n) => [n.atSec, n.kind, n.severity, n.beat]),
      [
        [12, 'caption', 'high', 1],
        [13, 'pacing', 'medium', 1],
        [50, 'sound', 'low', 2],
        [120, 'glitch', 'high', 2],
      ],
    );
  });

  it('keeps at most the limit, dropping the least severe', () => {
    const many = Array.from({ length: MAX_AI_NOTES + 10 }, (_, i) => ({
      at_sec: i * 4,
      kind: 'pacing' as const,
      severity: (i < 5 ? 'high' : 'low') as 'high' | 'low',
      note: `Note ${i}`,
    }));
    const kept = normalizeWatchNotes(many, { ...context, totalSec: 1000 });
    assert.equal(kept.length, MAX_AI_NOTES);
    assert.equal(kept.filter((n) => n.severity === 'high').length, 5);
  });

  it('drops caption "typos" that only correct the captions to the narration (misreads)', () => {
    // Real notes from a run on a 360p copy: every caption was in fact correct
    assert.equal(misreadCaption("The caption reads 'leaving' instead of 'leaning' ('leaning against the wrong wall').", 'that it is leaning against the wrong wall.'), true);
    assert.equal(misreadCaption("There is a typo in the caption displaying 'consistentk.' instead of 'consistent.'.", 'is fairly consistent. When'), true);
    assert.equal(misreadCaption("The caption shows 'thinks you're playing?' instead of 'think you're playing?'.", 'Which one do you think you’re playing?'), true);
    assert.equal(misreadCaption('Captions cover the face of the speaker.', 'anything'), false);
    assert.equal(misreadCaption("The title card reads 'Tresaury' instead of 'Treasury'.", 'The banks failed.'), false);
    const kept = normalizeWatchNotes(
      [
        { at_sec: 1, kind: 'caption', severity: 'medium', note: "The caption reads 'you finaly got it' instead of 'you finally got it'." },
        { at_sec: 2, kind: 'caption', severity: 'medium', note: 'The caption sits over the face.' },
      ],
      context,
    );
    assert.deepEqual(kept.map((n) => n.text), ['The caption sits over the face.']);
  });
});
