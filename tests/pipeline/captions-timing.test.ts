import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateAssCaptions, groupPhrases, toAssColour, type CaptionWord } from '../../src/pipeline/assembly/captions.ts';
import { captionZonesFromTracks, loadCaptionWords } from '../../src/pipeline/assembly/caption-sources.ts';
import { saveWordTimings } from '../../src/pipeline/tts/word-timings.ts';

const timed = (text: string, gapAfter: Record<number, number> = {}): Array<{ word: string; start: number; end: number }> => {
  let t = 0;
  return text.split(' ').map((word, i) => {
    const w = { word, start: t, end: t + 0.3 };
    t += 0.35 + (gapAfter[i] ?? 0);
    return w;
  });
};

describe('Captions on the narrator\'s real timing', () => {
  it('groups words into phrases at clause ends, pauses and length limits', () => {
    const toWords = (text: string, gaps: Record<number, number> = {}): CaptionWord[] =>
      timed(text, gaps).map((w) => ({ word: w.word, startMs: w.start * 1000, endMs: w.end * 1000 }));
    const group = (words: CaptionWord[]) => groupPhrases(words, 6, 38).map((p) => p.map((w) => w.word).join(' '));

    // Sentence ends and the word limit break phrases; a short clause keeps its comma inline
    assert.deepEqual(group(toWords('Prices fell, banks failed. Then silence fell over the whole city tonight')), [
      'Prices fell, banks failed.',
      'Then silence fell over the whole',
      'city tonight',
    ]);
    // A lone word left by the limit joins the phrase before it instead of flashing up alone
    assert.deepEqual(group(toWords('Then silence fell over the whole city')), ['Then silence fell over the whole city']);
    // A pause in the narration starts a new phrase; a comma ends a long enough clause
    assert.deepEqual(group(toWords('The market rose for years, until one morning it simply broke', { 7: 0.6 })), [
      'The market rose for years,',
      'until one morning',
      'it simply broke',
    ]);
  });

  it('lights each word when it is spoken, offset to where the beat\'s voice starts', () => {
    const { dialogues } = generateAssCaptions({
      beats: [{ index: 3, text: 'Wall Street crashed' }],
      units: [{ unit_index: 3, duration_ms: 1500 }],
      beatStartMs: [10_000],
      words: { 3: [{ word: 'Wall', start: 0.1, end: 0.4 }, { word: 'Street', start: 0.45, end: 0.8 }, { word: 'crashed', start: 0.9, end: 1.4 }] },
      highlightHex: '#f2c200',
    });
    assert.deepEqual(dialogues.map((d) => d.startMs), [10_100, 10_450, 10_900]);
    assert.equal(dialogues[2].endMs, 11_900, 'the phrase holds briefly after its last word');
    assert.match(dialogues[1].text, /^Wall \{\\c&H00C2F2&\}Street\{\\r\} crashed$/);
    assert.equal(toAssColour('#e2512e'), '&H2E51E2&');
  });

  it('hides during full-screen text and rises above lower-thirds', () => {
    const base = {
      beats: [{ index: 0, text: 'one two three. four five six.' }],
      units: [{ unit_index: 0, duration_ms: 3000 }],
      words: { 0: [0, 1, 2, 3, 4, 5].map((i) => ({ word: ['one', 'two', 'three.', 'four', 'five', 'six.'][i], start: i * 0.5, end: i * 0.5 + 0.4 })) },
    };
    const hidden = generateAssCaptions({ ...base, zones: [{ startMs: 0, endMs: 1500, kind: 'hide' }] });
    assert.ok(hidden.dialogues.every((d) => d.startMs >= 1500), 'first phrase hidden while text is on screen');
    const raised = generateAssCaptions({ ...base, zones: [{ startMs: 1500, endMs: 3000, kind: 'raise' }] });
    assert.deepEqual([...new Set(raised.dialogues.map((d) => d.style))], ['VoxMinimal', 'VoxMinimalRaised']);
    assert.match(raised.assContent, /Style: VoxMinimal, Segoe UI Semibold,/, 'a font installed with Windows');
  });

  it('uppercases and pops the active word in the social preset', () => {
    const { dialogues } = generateAssCaptions({
      beats: [{ index: 0, text: 'big news' }],
      units: [{ unit_index: 0, duration_ms: 1000 }],
      preset: 'social_pop',
      words: { 0: timed('big news') },
    });
    assert.match(dialogues[0].text, /\{\\c&H00D4FF&\\fscx112\\fscy112\}BIG\{\\r\} NEWS/);
  });
});

describe('Caption sources', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-sources-'));
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('uses word timings only when they were made for the current text', async () => {
    const audio = path.join(dir, 'beat.mp3');
    await saveWordTimings(audio, { version: 1, source: 'provider', text: 'Wall Street  crashed', spokenText: 'Wall Street crashed', durationMs: 1500, words: timed('Wall Street crashed') } as never);
    const words = await loadCaptionWords([
      { index: 0, text: 'Wall Street crashed', audioPath: audio },
      { index: 1, text: 'The text was edited after voicing', audioPath: audio },
      { index: 2, text: 'No audio yet' },
    ]);
    assert.deepEqual(Object.keys(words), ['0']);
  });

  it('reads where full-screen text and name captions appear from composed beats', async () => {
    const track = path.join(dir, 'visuals_beat_4.mp4');
    await fs.writeFile(
      `${track}.shots.json`,
      JSON.stringify({
        beatIndex: 4,
        shots: [
          { renderedType: 'title', startSec: 0, durationSec: 2 },
          { renderedType: 'archive', startSec: 2, durationSec: 3, note: 'relevance 9/10; caption: Herbert Hoover' },
          { renderedType: 'stock', startSec: 5, durationSec: 2 },
        ],
      }),
    );
    const zones = await captionZonesFromTracks([{ sceneStartMs: 60_000, trackPath: track }, { sceneStartMs: 0, trackPath: null }]);
    assert.deepEqual(zones, [
      { startMs: 60_000, endMs: 62_000, kind: 'hide' },
      { startMs: 62_000, endMs: 65_000, kind: 'raise' },
    ]);
  });
});
