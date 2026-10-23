import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveWordTimings } from '../../src/pipeline/tts/word-timings.ts';
import { applyCaptionEdits, baseCaptionWords, normalizeCaptionEdit } from '../../src/pipeline/assembly/caption-edits.ts';
import { captionEditorBeats, saveCaptionEdit } from '../../src/pipeline/assembly/caption-editor-data.ts';
import { generateAssCaptions } from '../../src/pipeline/assembly/captions.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const timed = (text: string) => text.split(' ').map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.35 }));
const beats = [
  { index: 0, text: 'In nineteen twenty-nine the market crashed hard.', durationSec: 3 },
  { index: 1, text: 'Nobody saw it coming.', durationSec: 2 },
];
const words = { 0: timed(beats[0].text) };

describe('Caption editor', () => {
  it('applies word fixes, dropped words, line breaks and highlights by position', () => {
    const basis = baseCaptionWords(beats[0].text, words[0], 3).map((w) => w.word);
    assert.deepEqual(basis, ['In', 'nineteen', 'twenty-nine', 'the', 'market', 'crashed', 'hard.']);
    const out = applyCaptionEdits(beats, words, {
      0: { basis, fixes: { 1: '1929', 2: '' }, breaks: [3], emphasis: [5] },
    });
    assert.deepEqual(out[0].map((w) => w.word), ['In', '1929', 'the', 'market', 'crashed', 'hard.']);
    assert.equal(out[0][1].start, 0.4, 'a fixed word keeps its timing');
    assert.equal(out[0][2].breakBefore, true, 'the line break lands on "the"');
    assert.equal(out[0][4].emphasis, true);
    assert.equal(out[1], undefined, 'an unedited beat is left as it was');
  });

  it('spreads an untimed beat evenly, hides beats, keeps files plain, and ignores stale edits', () => {
    const basis1 = baseCaptionWords(beats[1].text, undefined, 2).map((w) => w.word);
    const out = applyCaptionEdits(beats, words, { 1: { basis: basis1, emphasis: [0] } });
    assert.deepEqual(out[1].map((w) => [w.word, w.start]), [['Nobody', 0], ['saw', 0.5], ['it', 1], ['coming.', 1.5]]);

    assert.deepEqual(applyCaptionEdits(beats, words, { 1: { basis: basis1, hidden: true } })[1], []);
    const files = applyCaptionEdits(beats, words, { 1: { basis: basis1, hidden: true, emphasis: [0], fixes: { 0: 'NOBODY' } } }, { forFiles: true });
    assert.deepEqual(files[1].map((w) => w.word), ['NOBODY', 'saw', 'it', 'coming.'], 'subtitle files keep hidden beats and take fixes');
    assert.equal(files[1][0].emphasis, undefined);

    const stale = applyCaptionEdits(beats, words, { 0: { basis: ['Old', 'words'], fixes: { 0: 'X' } } });
    assert.equal(stale[0], words[0], 'an edit for other words is set aside');
  });

  it('burns the edits into the captions', () => {
    const basis = baseCaptionWords(beats[0].text, words[0], 3).map((w) => w.word);
    const edited = applyCaptionEdits(beats, words, { 0: { basis, fixes: { 1: '1929', 2: '' }, breaks: [3], emphasis: [5] }, 1: { basis: ['Nobody', 'saw', 'it', 'coming.'], hidden: true } });
    const { dialogues } = generateAssCaptions({
      beats,
      units: [{ unit_index: 0, duration_ms: 3000 }, { unit_index: 1, duration_ms: 2000 }],
      beatStartMs: [0, 3000],
      words: edited,
      highlightHex: '#ff0000',
    });
    const text = dialogues.map((d) => d.text.replace(/\{[^}]*\}/g, '')).join('\n');
    assert.ok(!/twenty-nine|nineteen/.test(text), 'fixed and dropped words are gone');
    assert.ok(!/Nobody/.test(text), 'the hidden beat has no captions');
    assert.ok(dialogues.every((d) => !d.text.replace(/\{[^}]*\}/g, '').includes('1929 the')), 'the new line starts at "the"');
    assert.deepEqual(
      dialogues.map((d) => d.text),
      [
        '{\\c&H0000FF&}In{\\r} 1929',
        'In {\\c&H0000FF&}1929{\\r}',
        '{\\c&H0000FF&}the{\\r} market {\\c&H0000FF&}crashed{\\r} hard.',
        'the {\\c&H0000FF&}market{\\r} {\\c&H0000FF&}crashed{\\r} hard.',
        'the market {\\c&H0000FF&}crashed{\\r} hard.',
        'the market {\\c&H0000FF&}crashed{\\r} {\\c&H0000FF&}hard.{\\r}',
      ],
      '"crashed" stays in the accent colour while its line is up',
    );
  });

  it('cleans submitted edits', () => {
    const edit = normalizeCaptionEdit({ basis: ['a', 'b', 'c'], fixes: { 0: 'a', 1: 'B', 9: 'x' }, breaks: [0, 2, 2, 7], emphasis: [1, -1], hidden: 'yes' });
    assert.deepEqual(edit, { basis: ['a', 'b', 'c'], fixes: { 1: 'B' }, breaks: [2], emphasis: [1] });
    assert.equal(normalizeCaptionEdit({ basis: 'nope' }), null);
  });

  it('saves an edit only for the words the beat has now, and removes an empty one', async () => {
    const { supabase, db } = createMockSupabase({
      videos: [{ id: 'v-cap', script_json: { beats: [{ text: 'Hello there world.' }] } }],
    });
    const [beat] = await captionEditorBeats(supabase, 'v-cap');
    assert.deepEqual(beat.words, ['Hello', 'there', 'world.']);
    assert.equal(beat.timed, false);

    await saveCaptionEdit(supabase, 'v-cap', 0, { basis: beat.words, emphasis: [2] });
    assert.deepEqual(db.videos[0].script_json.caption_edits, { 0: { basis: ['Hello', 'there', 'world.'], emphasis: [2] } });
    assert.deepEqual(db.videos[0].script_json.beats, [{ text: 'Hello there world.' }], 'the rest of the script is kept');

    await assert.rejects(saveCaptionEdit(supabase, 'v-cap', 0, { basis: ['Other'], emphasis: [0] }), /words changed/);
    await saveCaptionEdit(supabase, 'v-cap', 0, { basis: beat.words });
    assert.deepEqual(db.videos[0].script_json.caption_edits, {});

    db.videos[0].script_json.caption_edits = { 0: { basis: ['Old'], hidden: true } };
    assert.equal((await captionEditorBeats(supabase, 'v-cap'))[0].stale, true);
  });

  it('before the first render, reads the words the render will use from the latest voicing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capvoice-'));
    try {
      const audio = path.join(dir, 'beat_0.mp3');
      await fs.writeFile(audio, 'mp3');
      await saveWordTimings(audio, {
        version: 1,
        source: 'provider',
        text: 'Hello there world.',
        spokenText: 'Hello there world.',
        durationMs: 1500,
        words: [
          { word: 'Hello', start: 0, end: 0.4 },
          { word: 'there,', start: 0.5, end: 0.9 },
          { word: 'world.', start: 1, end: 1.4 },
        ],
      } as never);
      const { supabase } = createMockSupabase({
        videos: [{ id: 'v-voiced', script_json: { beats: [{ text: 'Hello there world.' }] } }],
        yt_jobs: [{ id: 'j-old', video_id: 'v-voiced', created_at: '2026-10-01T00:00:00Z' }],
        yt_job_units: [{ job_id: 'j-old', stage: 'tts', unit_index: 0, status: 'done', output_path: audio }],
      });
      const [beat] = await captionEditorBeats(supabase, 'v-voiced');
      assert.equal(beat.timed, true);
      assert.deepEqual(beat.words, ['Hello', 'there,', 'world.'], 'the timed words, as the render sees them');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
