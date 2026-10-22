import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRhythm, planToRhythmShots, type RhythmShot } from '../../src/lib/script/visual-rhythm.ts';
import { repairRhythm } from '../../src/lib/script/shot-planner.ts';
import { coverGaps, MAX_EXTENDED_SHOT_SEC, type ComposedShot } from '../../src/pipeline/visuals/shot-composer.ts';
import type { ScriptBeat, ShotPlan, ShotType } from '../../src/lib/script/generate-script.ts';

const rs = (type: string, extra: Partial<RhythmShot> = {}, i = 0): RhythmShot => ({ beat: i, shot: 0, type, seconds: 4, ...extra });
const seq = (...types: string[]) => types.map((t, i) => rs(t, {}, i));
const rules = (types: RhythmShot[]) => analyzeRhythm(types, 'render').issues.map((i) => i.rule);

const plan = (visual_type: ShotType, extra: Partial<ShotPlan> = {}): ShotPlan => ({
  visual_type,
  visual_query: `${visual_type} query`,
  covers: 'one two three four five six seven eight nine ten',
  word_start: 0,
  word_count: 10,
  ...extra,
});
const beatOf = (index: number, shots: ShotPlan[]): ScriptBeat => ({
  index,
  text: 'one two three four five six seven eight nine ten',
  visual_type: 'stock',
  visual_query: 'city street',
  duration_estimate_seconds: 5,
  shots,
});

describe('Visual rhythm analysis', () => {
  it('flags graphics back to back even when their types differ', () => {
    assert.ok(rules(seq('stat', 'kinetic_text', 'chart', 'stock')).includes('non_footage_run'));
    assert.ok(!rules(seq('stat', 'stock', 'chart', 'stock')).includes('non_footage_run'));
  });

  it('flags one graphic type crowding a stretch, but not maps', () => {
    assert.ok(rules(seq('stat', 'stock', 'stat', 'stock', 'stat', 'stock')).includes('type_density'));
    assert.ok(!rules(seq('geo_map', 'stock', 'geo_map', 'stock', 'geo_map', 'stock')).includes('type_density'));
  });

  it('flags repeated footage searches, still-photo runs and fallbacks', () => {
    const shots = [
      rs('stock', { query: 'container ship canal lock' }, 0),
      rs('stock', { query: 'container ship in canal lock' }, 1),
      rs('archive', { still: true }, 2),
      rs('archive', { still: true }, 3),
      rs('archive', { still: true }, 4),
      rs('kinetic_text', { fallback: true }, 5),
    ];
    const found = rules(shots);
    assert.ok(found.includes('repeated_footage'));
    assert.ok(found.includes('still_run'));
    assert.ok(found.includes('fallback'));
  });

  it('scores a varied sequence high and a slideshow low', () => {
    const varied = analyzeRhythm(seq('stock', 'stat', 'archive', 'geo_map', 'stock', 'chart', 'archive', 'stock'), 'plan');
    assert.equal(varied.risk, 'low');
    assert.equal(varied.score, 100);
    const slideshow = analyzeRhythm(seq('stat', 'kinetic_text', 'stat', 'kinetic_text', 'stat', 'kinetic_text', 'chart', 'stock'), 'plan');
    assert.notEqual(slideshow.risk, 'low');
    assert.ok(slideshow.graphicsShare > 0.55);
  });

  it('leaves the still share blank when older renders did not record it', () => {
    assert.equal(analyzeRhythm(seq('stock', 'archive'), 'render').stillShare, undefined);
    assert.equal(analyzeRhythm([rs('stock', { still: false }), rs('archive', { still: true }, 1)], 'render').stillShare, 0.5);
  });
});

describe('Shot plan rhythm repair', () => {
  it('turns a third graphic in a row into footage, across beats', () => {
    const { beats, fixes } = repairRhythm([beatOf(0, [plan('stat'), plan('kinetic_text', { kinetic: { phrase: 'x', emphasis: [] } })]), beatOf(1, [plan('chart'), plan('stock')])]);
    assert.deepEqual(beats.flatMap((b) => b.shots!.map((s) => s.visual_type)), ['stat', 'kinetic_text', 'stock', 'stock']);
    assert.equal(fixes[0].rule, 'non_footage_run');
  });

  it('keeps graphics under their share of a longer video, dropping the least essential first', () => {
    // 10 shots, 7 of them graphics: well over 55%
    const types: ShotType[] = ['geo_map', 'stock', 'stat', 'chart', 'stock', 'kinetic_text', 'timeline', 'stock', 'comparison', 'newspaper'];
    const { beats, fixes } = repairRhythm(types.map((t, i) => beatOf(i, [plan(t)])));
    const after = analyzeRhythm(planToRhythmShots(beats), 'plan');
    assert.ok(after.graphicsShare <= 0.55, `graphics share ${after.graphicsShare}`);
    const kept = beats.map((b) => b.shots![0].visual_type);
    assert.ok(kept.includes('geo_map') && kept.includes('newspaper'), 'maps and newspapers are kept longest');
    assert.ok(!kept.includes('kinetic_text'), 'text cards go first');
    assert.ok(fixes.some((f) => f.rule === 'graphics_share'));
  });
});

describe('Footage covering gaps', () => {
  const composed = (renderedType: string, i: number, extra: Partial<ComposedShot> = {}): ComposedShot => ({
    clipPath: `shot_${i}.mp4`,
    renderedType,
    plannedType: 'stock',
    startSec: i * 4,
    durationSec: 4,
    frames: 120,
    plan: { ...plan('stock'), covers: `part${i}`, word_start: i * 5, word_count: 5 },
    ...extra,
  });
  const chosen = { id: 'c1', provider: 'pixabay', mediaType: 'video' as const, thumbnailUrl: 't', downloadUrl: 'd' };

  it('holds the footage before a text-card fallback over both slots', async () => {
    const calls: Array<{ frames: number; covers: string; wordCount: number }> = [];
    const out = await coverGaps(
      [composed('stock', 0, { chosen }), composed('kinetic_text', 1, { fallback: true }), composed('chart', 2)],
      async (_n, slot, clipPath) => {
        calls.push({ frames: slot.frames, covers: slot.shot.covers, wordCount: slot.shot.word_count });
        return { clipPath, renderedType: 'stock', chosen };
      },
      'dir',
      0,
    );
    assert.deepEqual(out.map((s) => s.renderedType), ['stock', 'chart']);
    assert.deepEqual(calls, [{ frames: 240, covers: 'part0 part1', wordCount: 10 }]);
    assert.equal(out[0].frames, 240);
    assert.match(out[0].note ?? '', /held over/);
  });

  it('uses the footage after the gap when there is none before it', async () => {
    const out = await coverGaps(
      [composed('color', 0), composed('archive', 1, { chosen })],
      async (_n, slot, clipPath) => ({ clipPath, renderedType: 'archive', chosen }),
      'dir',
      0,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].startSec, 0, 'the merged shot starts where the gap did');
  });

  it('keeps the gap when there is no footage neighbour, or the shot would drag', async () => {
    const extend = async () => {
      throw new Error('should not be called');
    };
    const lonely = await coverGaps([composed('stat', 0), composed('kinetic_text', 1, { fallback: true })], extend, 'dir', 0);
    assert.equal(lonely.length, 2);
    const long = Math.round(MAX_EXTENDED_SHOT_SEC * 30);
    const dragging = await coverGaps(
      [composed('stock', 0, { chosen, frames: long }), composed('kinetic_text', 1, { fallback: true })],
      extend,
      'dir',
      0,
    );
    assert.equal(dragging.length, 2);
  });
});
