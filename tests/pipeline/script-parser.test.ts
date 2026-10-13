import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSrtTimestampToSeconds,
  extractSrtCues,
  parseSrtToBeats,
  parseRawTextToParagraphBeats,
  splitSentences,
  extractQuickVisualQuery,
} from '../../src/lib/script/parser';

describe('Script Parsing: SRT & Raw Text', () => {
  describe('SRT Timestamp Parsing', () => {
    it('converts HH:MM:SS,mmm to seconds correctly', () => {
      assert.equal(parseSrtTimestampToSeconds('00:00:00,000'), 0);
      assert.equal(parseSrtTimestampToSeconds('00:00:01,500'), 1.5);
      assert.equal(parseSrtTimestampToSeconds('00:01:30,250'), 90.25);
      assert.equal(parseSrtTimestampToSeconds('01:00:00,000'), 3600);
      // Handles dot separator as well
      assert.equal(parseSrtTimestampToSeconds('00:02:15.500'), 135.5);
    });
  });

  describe('extractSrtCues', () => {
    it('extracts raw cues with cleaned text and timestamps', () => {
      const srt = `1
00:00:01,000 --> 00:00:03,500
Hello and <i>welcome</i> to the video!

2
00:00:04,000 --> 00:00:07,000
Today we are building an automated pipeline.
`;

      const cues = extractSrtCues(srt);
      assert.equal(cues.length, 2);
      assert.equal(cues[0].startTimeSeconds, 1);
      assert.equal(cues[0].endTimeSeconds, 3.5);
      assert.equal(cues[0].durationSeconds, 2.5);
      assert.equal(cues[0].text, 'Hello and welcome to the video!');

      assert.equal(cues[1].startTimeSeconds, 4);
      assert.equal(cues[1].endTimeSeconds, 7);
      assert.equal(cues[1].durationSeconds, 3);
      assert.equal(cues[1].text, 'Today we are building an automated pipeline.');
    });
  });

  describe('parseSrtToBeats with Smart Merging', () => {
    it('groups short cues into balanced beats when smart merging is enabled', () => {
      const srt = `1
00:00:01,000 --> 00:00:02,500
Here is the first sentence.

2
00:00:02,600 --> 00:00:04,000
Here is the second sentence.

3
00:00:04,100 --> 00:00:06,500
And here is the third sentence.

4
00:00:10,000 --> 00:00:14,000
After a long pause, we start a new thought.
`;

      const beats = parseSrtToBeats(srt, { minBeatDurationSeconds: 4.0, maxGapSeconds: 2.0 });
      // Cues 1 & 2 combine (~3s + sentence boundary or cue 3), cue 4 has a long pause so it splits
      assert.ok(beats.length >= 2, 'Should create multiple scene beats');

      // First beat should have combined text
      assert.ok(beats[0].text.includes('Here is the first sentence.'));
      assert.ok(beats[0].duration_estimate_seconds >= 4.0);
      assert.equal(beats[0].visual_type, 'stock');
      assert.ok(beats[0].visual_query.length > 0);

      // Cue 4 is isolated due to gap > 2.0s; narration is re-voiced, so duration is a word-count estimate
      const lastBeat = beats[beats.length - 1];
      assert.ok(lastBeat.text.includes('After a long pause'));
      assert.equal(lastBeat.duration_estimate_seconds, 3.9);
    });

    it('regroups subtitle cues cut mid-sentence into whole-sentence beats', () => {
      const srt = `1
00:00:00,000 --> 00:00:03,000
By the closing bell, more than sixteen million

2
00:00:03,100 --> 00:00:06,000
shares had changed hands. The Exchange sat on Broad

3
00:00:06,100 --> 00:00:09,000
Street, just off Wall Street, steps from J.P. Morgan.
`;
      const beats = parseSrtToBeats(srt, { minBeatDurationSeconds: 4 });
      for (const b of beats) {
        assert.match(b.text, /^[A-Z]/, `beat should start a sentence: ${b.text}`);
        assert.match(b.text, /[.!?]$/, `beat should end a sentence: ${b.text}`);
      }
    });

    it('keeps 1-to-1 cues when minBeatDurationSeconds is 0', () => {
      const srt = `1
00:00:01,000 --> 00:00:03,000
Line 1

2
00:00:03,500 --> 00:00:06,000
Line 2
`;
      const beats = parseSrtToBeats(srt, { minBeatDurationSeconds: 0 });
      assert.equal(beats.length, 2);
      assert.equal(beats[0].index, 0);
      assert.equal(beats[0].text, 'Line 1');
      assert.equal(beats[0].duration_estimate_seconds, 2);
      assert.equal(beats[1].index, 1);
      assert.equal(beats[1].text, 'Line 2');
      assert.equal(beats[1].duration_estimate_seconds, 2.5);
    });
  });

  describe('parseRawTextToParagraphBeats', () => {
    it('splits raw markdown and text into clean paragraph beats with word-count pacing', () => {
      const raw = `# Video Introduction
This is the opening scene where we introduce the premise and grab viewer attention.

## Section 1: The Core Architecture
In this section we dive deep into how the database works and why you should care.

* Summary conclusion bullet point for the outro.
`;

      const beats = parseRawTextToParagraphBeats(raw);
      assert.equal(beats.length, 3);

      assert.equal(beats[0].index, 0);
      assert.equal(
        beats[0].text,
        'This is the opening scene where we introduce the premise and grab viewer attention.',
      );
      assert.equal(beats[0].visual_type, 'stock');
      assert.ok(beats[0].duration_estimate_seconds >= 3);

      assert.equal(beats[1].index, 1);
      assert.equal(
        beats[1].text,
        'In this section we dive deep into how the database works and why you should care.',
      );

      assert.equal(beats[2].index, 2);
      assert.equal(
        beats[2].text,
        'Summary conclusion bullet point for the outro.',
      );
    });

    it('returns empty array on blank input', () => {
      assert.deepEqual(parseRawTextToParagraphBeats('   \n\n   '), []);
    });

    it('splits long paragraphs into sentence-aligned beats of 12-35 words, keeping every word', () => {
      const paragraph =
        'Tuesday, October 29, 1929. On the floor of the New York Stock Exchange, sell orders bury the clerks. ' +
        'By the closing bell, more than sixteen million shares have changed hands, a record that would stand for decades. ' +
        'It all happened within a few blocks of lower Manhattan. The Exchange sat on Broad Street, just off Wall Street, steps from the headquarters of J.P. Morgan and Company. ' +
        'Bankers pooled money, and broker Richard Whitney bid for U.S. Steel on the floor, briefly steadying the market.';

      const beats = parseRawTextToParagraphBeats(paragraph);

      assert.ok(beats.length >= 3, `expected several beats, got ${beats.length}`);
      for (const b of beats) {
        const words = b.text.split(/\s+/).length;
        assert.ok(words <= 35, `beat too long (${words} words): ${b.text}`);
        assert.match(b.text, /[.!?]$/, 'beats end on a sentence boundary');
      }
      assert.equal(beats.map((b) => b.text).join(' '), paragraph);
      assert.ok(beats.some((b) => b.text.includes('J.P. Morgan and Company.')));
      assert.ok(beats.some((b) => b.text.includes('bid for U.S. Steel on the floor')));
    });
  });

  describe('splitSentences', () => {
    it('does not break on initials or abbreviations', () => {
      assert.deepEqual(
        splitSentences('Variety summed it up: "Wall St. Lays an Egg." Then J.P. Morgan stepped in. Done!'),
        ['Variety summed it up: "Wall St. Lays an Egg."', 'Then J.P. Morgan stepped in.', 'Done!'],
      );
    });
  });

  describe('extractQuickVisualQuery', () => {
    it('keeps meaningful words instead of the first eight words', () => {
      assert.equal(
        extractQuickVisualQuery('Tuesday, October 29, 1929. On the floor of the New York Stock Exchange, sell orders bury the clerks.'),
        'Tuesday October 29 1929 floor New',
      );
      assert.equal(
        extractQuickVisualQuery('It all happened within a few blocks of lower Manhattan.'),
        'happened blocks lower Manhattan',
      );
    });
  });

  it('SRT merging folds tiny leftover beats into the previous beat', () => {
    const srt = `1
00:00:00,000 --> 00:00:05,000
The market opened calmly that morning and traders expected a quiet day.

2
00:00:09,000 --> 00:00:10,000
Then it broke.
`;
    const beats = parseSrtToBeats(srt, { minBeatDurationSeconds: 4, maxGapSeconds: 1.5 });
    assert.equal(beats.length, 1);
    assert.ok(beats[0].text.endsWith('Then it broke.'));
  });
});
