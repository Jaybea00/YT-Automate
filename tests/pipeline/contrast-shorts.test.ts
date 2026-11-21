import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  asContrastShort,
  cleanLabel,
  contrastBannerLabels,
  contrastMinutes,
  contrastSegments,
  contrastSetupFrom,
  contrastShortRules,
  CONTRAST_SWITCH_CARD,
  CONTRAST_SWITCH_MS,
} from '../../src/lib/script/contrast.ts';
import { shortFormatFrom, shortFormatMinutes, shortFormatWriterInput, withShortFormat } from '../../src/lib/script/short-formats.ts';
import { ReadyScriptSchema, scriptFromReady } from '../../src/lib/script/ready-script.ts';
import { shortBanners } from '../../src/pipeline/publish/shorts.ts';

const myth = { labels: ['The myth', 'The truth'] as [string, string], length: 'story' as const };

describe('Contrast Shorts', () => {
  it('reads the setup from a request, tidying labels and refusing half a pair', () => {
    assert.deepEqual(contrastSetupFrom({ labels: [' "The myth" ', 'The   truth'], length: 'quick' }), { labels: ['The myth', 'The truth'], length: 'quick' });
    assert.equal(contrastSetupFrom({ labels: ['The myth', ''] }), null);
    assert.equal(contrastSetupFrom({ labels: ['One'] }), null);
    assert.equal(contrastSetupFrom({ labels: ['A', 'B'], length: 'epic' })?.length, 'story', 'unknown lengths fall back to story');
    assert.equal(cleanLabel('x'.repeat(50)).length, 30);
  });

  it('sizes quick, story and series Shorts', () => {
    assert.ok(contrastMinutes('quick') < 0.35);
    assert.ok(contrastMinutes('story') > 0.6 && contrastMinutes('story') < 0.9);
    assert.ok(contrastMinutes('series') > 1.6 && contrastMinutes('series') < 2.5);
  });

  it('tells the writer the labels, the sides and the shape', () => {
    const rules = contrastShortRules(myth);
    assert.match(rules, /"The myth" against "The truth"/);
    assert.match(rules, /"contrast_side": "a"/);
    assert.match(rules, /One pair/);
    assert.match(contrastShortRules({ ...myth, length: 'series' }), /3-5 pairs/);
  });

  it('finds where each side starts, from the beats’ sides', () => {
    const beats = [
      { text: 'Vikings wore horned helmets.', contrast_side: 'a' as const },
      { text: 'Every movie says so.', contrast_side: 'a' as const },
      { text: 'Not one horned helmet has ever been found.', contrast_side: 'b' as const },
      { text: 'The horns came from an opera costume in 1876.', contrast_side: 'b' as const },
    ];
    assert.deepEqual(contrastSegments(beats), [
      { beat: 0, side: 'a' },
      { beat: 2, side: 'b' },
    ]);
    const series = [...beats, { text: 'Napoleon was short.', contrast_side: 'a' as const }, { text: 'He was average height.', contrast_side: 'b' as const }];
    assert.deepEqual(contrastSegments(series, 'series').map((s) => `${s.beat}${s.side}`), ['0a', '2b', '4a', '5b']);
  });

  it('splits one pair about 40% in when no sides were given, but never guesses a series', () => {
    const beats = ['one two three four', 'five six', 'seven eight nine ten', 'eleven twelve'].map((text) => ({ text }));
    // 12 words: the first side runs until 40% (4.8 words) is passed, after the second beat
    assert.deepEqual(contrastSegments(beats), [
      { beat: 0, side: 'a' },
      { beat: 2, side: 'b' },
    ]);
    assert.deepEqual(contrastSegments(beats, 'series'), []);
    assert.deepEqual(contrastSegments([{ text: 'only one' }]), []);
  });

  it('puts each label on screen, with a VS card at every switch', () => {
    const labels = contrastBannerLabels(['The myth', 'The truth'], [
      { beat: 0, side: 'a' },
      { beat: 2, side: 'b' },
    ]);
    assert.deepEqual(labels, [
      { text: 'THE MYTH', beat: 0 },
      { text: CONTRAST_SWITCH_CARD, beat: 2 },
      { text: 'THE TRUTH', beat: 2, offsetMs: CONTRAST_SWITCH_MS },
    ]);
    // On screen: the first label replaces the hook, the last stays to the end (no end card)
    const banners = shortBanners('HOOK', 40, {
      labels: [
        { text: 'THE MYTH', startMs: 0 },
        { text: 'VS…', startMs: 12000 },
        { text: 'THE TRUTH', startMs: 12700 },
      ],
      endCard: null,
    });
    assert.deepEqual(
      banners.map((b) => [b.text, b.startMs, b.endMs]),
      [
        ['THE MYTH', 0, 12000],
        ['VS…', 12000, 12700],
        ['THE TRUTH', 12700, 40000],
      ],
    );
  });

  it('marks the script as a contrast Short through the shared short formats', () => {
    const req = shortFormatFrom({ shortFormat: 'contrast', contrast: { labels: ['Before', 'After'], length: 'quick' } });
    assert.deepEqual(req, { shortFormat: 'contrast', contrast: { labels: ['Before', 'After'], length: 'quick' } });
    assert.equal(shortFormatMinutes(req), contrastMinutes('quick'));
    assert.deepEqual(shortFormatWriterInput(req), { format: 'short', contrast: { labels: ['Before', 'After'], length: 'quick' } });
    const s = withShortFormat({ title_options: ['Restoring a rusty axe'], beats: [] }, req) as ReturnType<typeof asContrastShort>;
    assert.equal(s.format, 'short');
    assert.deepEqual(s.contrast, { labels: ['Before', 'After'], length: 'quick' });
    assert.deepEqual(s.short, { parent_video_id: null, hook_banner: 'Restoring a rusty axe' });
    assert.deepEqual(shortFormatFrom({ shortFormat: 'contrast', contrast: { labels: ['Before'] } }), {}, 'half a pair is a normal video');
    assert.deepEqual(shortFormatFrom({ shortFormat: 'ranking', rankingItems: 10 }), { shortFormat: 'ranking', rankingItems: 10 });
    assert.equal(shortFormatMinutes({}), null);
  });

  it('keeps each beat’s side in a ready-made script', () => {
    const s = scriptFromReady(
      ReadyScriptSchema.parse({
        title_options: ['T'],
        beats: [
          { text: 'Vikings wore horned helmets.', contrast_side: 'a' },
          { text: 'None was ever found.', contrast_side: 'b' },
          { text: 'No side here.' },
        ],
      }),
    );
    assert.deepEqual(s.beats.map((b) => b.contrast_side), ['a', 'b', undefined]);
  });
});
