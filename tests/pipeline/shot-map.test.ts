import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shotMapDots, shotMapTemplate, xgAt, type ShotMapSpec } from '../../src/pipeline/visuals/motion/shot-map-template.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { finalizeBeatShots, verifyShot } from '../../src/lib/script/shot-planner.ts';
import { stylePack } from '../../src/lib/styles/packs.ts';
import { MOTION_RENDERERS } from '../../src/pipeline/visuals/motion-shots.ts';
import type { ScriptBeat } from '../../src/lib/script/generate-script.ts';

const spec: ShotMapSpec = {
  title: 'Germany 1-2 Italy',
  team: 'Italy',
  shots: 14,
  goals: 2,
  xg: 1.9,
  on_target: 7,
  key_shots: [{ label: "Balotelli 20'", x: 95, y: 46, outcome: 'goal', xg: 0.42 }],
};

describe('Tifo shot maps', () => {
  it('draws every shot: the described ones where the narration puts them, the rest marked illustrative', () => {
    const dots = shotMapDots(spec);
    assert.equal(dots.length, 14);
    assert.equal(dots.filter((d) => d.outcome === 'goal').length, 2, 'two goals in all');
    assert.deepEqual([dots[0].x, dots[0].y, dots[0].label, dots[0].illustrative], [95, 46, "Balotelli 20'", false]);
    assert.ok(dots.slice(1).every((d) => d.illustrative && d.x >= 50 && d.y >= 0 && d.y <= 100), 'the rest on the attacking half');
    const onTarget = dots.filter((d) => d.outcome === 'goal' || d.outcome === 'saved').length;
    assert.equal(onTarget, 7);
    const xg = dots.reduce((n, d) => n + d.xg, 0);
    assert.ok(Math.abs(xg - 1.9) < 0.05, `the chances add up to the stated xG (${xg.toFixed(2)})`);
    assert.deepEqual(shotMapDots(spec), dots, 'the same map every render');
  });

  it('rates chances by where they are taken', () => {
    assert.ok(xgAt(96, 50) > xgAt(80, 50), 'closer is better');
    assert.ok(xgAt(90, 50) > xgAt(90, 10), 'central is better');
    assert.match(shotMapTemplate(themeForStyle('sport'), spec), /Unlabelled shot positions are illustrative/);
    const allDescribed = shotMapTemplate(themeForStyle('sport'), { ...spec, shots: 1, goals: 1, xg: 0.42, on_target: 1 });
    assert.doesNotMatch(allDescribed, /id="note"/, 'no note when every shot is described');
    assert.ok(MOTION_RENDERERS.shot_map);
  });

  it('only shows totals the narration or research states, and only in the sport style', () => {
    const beat: ScriptBeat = { index: 0, text: 'Italy had 14 shots and scored 2, from an xG of 1.9.', visual_type: 'stock', visual_query: 'football', duration_estimate_seconds: 6 };
    const ok = verifyShot({ visual_type: 'shot_map', covers: '', visual_query: 'Italy shots', shot_map: { ...spec, on_target: null } }, beat, []);
    assert.equal(ok.visual_type, 'shot_map');
    const invented = verifyShot({ visual_type: 'shot_map', covers: '', visual_query: 'Italy shots', shot_map: { ...spec, shots: 22, on_target: null } }, beat, []);
    assert.notEqual(invented.visual_type, 'shot_map', '22 shots is stated nowhere');
    const tooManyGoals = verifyShot(
      { visual_type: 'shot_map', covers: '', visual_query: 'x', shot_map: { ...spec, on_target: null, goals: 2, key_shots: [...spec.key_shots!, { label: 'A', x: 90, y: 50, outcome: 'goal' }, { label: 'B', x: 88, y: 40, outcome: 'goal' }] } },
      beat,
      [],
    );
    assert.ok(tooManyGoals.shot_map!.key_shots!.filter((k) => k.outcome === 'goal').length <= 2, 'never more described goals than the total');

    assert.ok(stylePack('sport')?.signatureShots?.includes('shot_map'));
    const director = [{ visual_type: 'shot_map' as const, covers: beat.text, visual_query: 'Italy shots', shot_map: { ...spec, on_target: null } }];
    assert.equal(finalizeBeatShots(beat, director, [], { signature: ['shot_map'] })[0].visual_type, 'shot_map');
    assert.notEqual(finalizeBeatShots(beat, director, [], { signature: [] })[0].visual_type, 'shot_map', 'not offered outside sport');
  });
});
