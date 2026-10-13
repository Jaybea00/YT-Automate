import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignWordTimings,
  estimateWordTimings,
  expectedSpokenWords,
  wordTimingsPathFor,
} from '../../src/pipeline/tts/word-timings.ts';
import { parseSilenceDetect } from '../../src/pipeline/utils/ffmpeg.ts';

// Real /dev/captioned_speech output from the local Kokoro server (bm_george) for this sentence
const TEXT = 'On Oct. 29, 1929, J.P. Morgan bankers bid for U.S. Steel as about $14 billion vanished, and the Dow later fell 89% to 41.22.';
const KOKORO = `On[-0.01-0.18] Oct.[0.18-0.70] twenty-nine[0.70-1.46] ,[1.46-1.56] nineteen[1.56-2.04] twenty-nine[2.04-2.89] ,[2.89-3.00] J-P.[3.00-3.44] Morgan[3.44-3.84] bankers[3.84-4.30] bid[4.30-4.59] for[4.59-4.73] U-S.[4.73-5.08] Steel[5.08-5.91] as[5.91-6.05] about[6.05-6.39] fourteen[6.39-6.98] billion[6.98-7.39] dollars[7.39-7.78] vanished[7.78-8.61] ,[8.61-8.71] and[8.71-8.83] the[8.83-8.91] Dow[8.91-9.14] later[9.14-9.55] fell[9.55-9.83] eighty-nine[9.83-10.44] percent[10.44-11.21] to[11.21-11.38] forty-one[11.38-11.93] point[11.93-12.25] two[12.25-12.50] two[12.50-13.19] .[13.19-13.34]`
  .split(' ')
  .map((t) => {
    const m = t.match(/^(.*)\[(-?[\d.]+)-([\d.]+)\]$/)!;
    return { word: m[1], start: Number(m[2]), end: Number(m[3]) };
  });

describe('Word timings: aligning spoken tokens to written words', () => {
  const aligned = alignWordTimings(TEXT, KOKORO, 13.3);
  const at = (word: string) => aligned.find((w) => w.word === word)!;

  it('returns one timing per written word, in order', () => {
    assert.equal(aligned.length, TEXT.split(/\s+/).length);
    for (let i = 1; i < aligned.length; i++) assert.ok(aligned[i].start >= aligned[i - 1].start - 1e-9);
  });

  it('maps expanded numbers back to the written figure', () => {
    assert.deepEqual([at('1929,').start, at('1929,').end], [1.56, 2.89]);
    assert.deepEqual([at('$14').start, at('billion').start], [6.39, 6.98]);
    assert.deepEqual([at('89%').start, at('89%').end], [9.83, 11.21], '"eighty-nine percent"');
    assert.deepEqual([at('41.22.').start, at('41.22.').end], [11.38, 13.19]);
  });

  it('splits adjacent numbers ("29, 1929") by their expected spoken length', () => {
    assert.deepEqual([at('29,').start, at('29,').end], [0.7, 1.46]);
    assert.equal(expectedSpokenWords('1929,'), 2);
    assert.equal(expectedSpokenWords('41.22.'), 4);
    assert.equal(expectedSpokenWords('89%'), 2);
    assert.equal(expectedSpokenWords('$14'), 1);
  });

  it('matches words the voice spelled differently', () => {
    assert.deepEqual([at('J.P.').start, at('U.S.').start, at('Steel').end], [3.0, 4.73, 5.91]);
  });

  it('extends a word over spoken extras like "dollars" so there is no gap', () => {
    assert.equal(at('billion').end, 7.78, '"billion" runs through the spoken "dollars"');
    assert.equal(at('vanished,').start, 7.78);
  });

  it('interpolates written words with no spoken counterpart', () => {
    const gappy = alignWordTimings('Prices fell sharply today.', [
      { word: 'Prices', start: 0, end: 0.5 },
      { word: 'today', start: 1.5, end: 2 },
    ], 2);
    assert.equal(gappy.length, 4);
    assert.ok(gappy[1].start >= 0.5 && gappy[2].end <= 1.5);
  });
});

describe('Word timings: estimates for providers without timings', () => {
  it('spreads words over the speech region in proportion to length and punctuation', () => {
    const est = estimateWordTimings('One two three. Four five six.', 6);
    assert.equal(est.length, 6);
    assert.equal(est[0].start, 0);
    assert.ok(est[5].end <= 6);
    const gapAfterSentence = est[3].start - est[2].end;
    const gapInside = est[1].start - est[0].end;
    assert.ok(gapAfterSentence > gapInside, 'sentence end leaves a pause');
  });

  it('anchors sentence breaks to detected silences', () => {
    // Speech 0.2-2.0 and 2.6-4.0, with a real pause at 2.0-2.6
    const est = estimateWordTimings('Black Tuesday came fast. Nobody saw it.', 4.2, [
      { start: 0, end: 0.2 },
      { start: 2.0, end: 2.6 },
      { start: 4.0, end: 4.2 },
    ]);
    assert.equal(est[0].start, 0.2);
    assert.equal(est[3].end, 2.0, '"fast." ends where the silence begins');
    assert.equal(est[4].start, 2.6, '"Nobody" starts where the silence ends');
    assert.equal(est[6].end, 4.0);
  });

  it('parses ffmpeg silencedetect output, closing a silence that runs to the end', () => {
    const stderr = `[silencedetect @ 0x1] silence_start: -0.0213
[silencedetect @ 0x1] silence_end: 0.18 | silence_duration: 0.2
[silencedetect @ 0x1] silence_start: 2.01
[silencedetect @ 0x1] silence_end: 2.6 | silence_duration: 0.59
[silencedetect @ 0x1] silence_start: 4.0`;
    assert.deepEqual(parseSilenceDetect(stderr, 4.2), [
      { start: 0, end: 0.18 },
      { start: 2.01, end: 2.6 },
      { start: 4.0, end: 4.2 },
    ]);
  });

  it('stores timings next to the audio file', () => {
    assert.equal(wordTimingsPathFor('C:/jobs/x/audio/tts_scene_3.mp3'), 'C:/jobs/x/audio/tts_scene_3.words.json');
  });
});
