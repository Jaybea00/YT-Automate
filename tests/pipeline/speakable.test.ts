import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toSpeakableText } from '../../src/pipeline/tts/speakable.ts';

describe('Speakable text for TTS', () => {
  it('expands abbreviated months and makes dates ordinal', () => {
    assert.equal(toSpeakableText('On Oct. 29, 1929, it broke.'), 'On October 29th, 1929, it broke.');
    assert.equal(toSpeakableText('By July 8, 1932 and March 3'), 'By July 8th, 1932 and March 3rd');
    assert.equal(toSpeakableText('On September 11 and 21, 22 and 23'), 'On September 11th and 21, 22 and 23');
    assert.equal(toSpeakableText('October 2nd stays'), 'October 2nd stays');
    assert.equal(toSpeakableText('In May 1929 prices rose'), 'In May 1929 prices rose', 'a year is not a day');
  });

  it('tells streets from saints', () => {
    assert.equal(toSpeakableText('Wall St. Lays an Egg'), 'Wall Street Lays an Egg');
    assert.equal(toSpeakableText('St. Louis traders panicked.'), 'Saint Louis traders panicked.');
  });

  it('expands titles and common abbreviations', () => {
    assert.equal(toSpeakableText('Dr. Fisher vs. the market, e.g. bankers'), 'Doctor Fisher versus the market, for example, bankers');
    assert.equal(toSpeakableText('Gen. Electric fell; No. 5 on the list'), 'General Electric fell; number 5 on the list');
  });

  it('keeps initials and figures the voices already read well', () => {
    const text = 'J.P. Morgan bid for U.S. Steel as about $14 billion vanished and the Dow fell 89%.';
    assert.equal(toSpeakableText(text), text);
  });

  it('speaks ranges and symbols', () => {
    assert.equal(toSpeakableText('From 1929–1933, R&D & trade fell ~40% and debt grew 10x.'), 'From 1929 to 1933, R&D and trade fell about 40% and debt grew 10 times.');
  });

  it('applies custom pronunciations, longest phrase first', () => {
    const out = toSpeakableText('Creditanstalt collapsed. The Creditanstalt Bank too.', [
      { term: 'Creditanstalt', say: 'kreh-dit-AHN-shtalt' },
      { term: 'Creditanstalt Bank', say: 'the Credit Bank' },
    ]);
    assert.equal(out, 'kreh-dit-AHN-shtalt collapsed. The the Credit Bank too.');
  });
});
