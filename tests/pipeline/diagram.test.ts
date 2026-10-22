import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyShot, fitGraphicsToTime } from '../../src/lib/script/shot-planner.ts';
import { diagramLayout, diagramRevealTimes, diagramTemplate, type DiagramSpec } from '../../src/pipeline/visuals/motion/diagram.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { shotCues } from '../../src/pipeline/assembly/sound-design.ts';
import type { ScriptBeat, ShotPlan } from '../../src/lib/script/generate-script.ts';

const narration =
  'The ship enters the chamber and the gates close. Then lake water flows in by gravity, and the ship rises 26 metres before the upper gates open.';
const beat: ScriptBeat = { index: 0, text: narration, visual_type: 'stock', visual_query: 'canal lock', duration_estimate_seconds: 10 };

const lockSteps = [
  { label: 'Ship enters the chamber', detail: 'Gates close behind it' },
  { label: 'Lake water flows in', detail: null },
  { label: 'Ship rises 26 metres', detail: null },
  { label: 'Upper gates open', detail: null },
];

describe('Diagram planning', () => {
  const verify = (diagram: Record<string, unknown>) =>
    verifyShot({ visual_type: 'diagram', covers: narration, visual_query: 'lock diagram', diagram: diagram as never }, beat, []);

  it('keeps steps that restate the narration', () => {
    const s = verify({ kind: 'process', title: 'How a lock lifts a ship', steps: lockSteps });
    assert.equal(s.visual_type, 'diagram');
    assert.equal(s.diagram?.steps.length, 4);
  });

  it('drops invented steps and unstated figures, and falls back to footage below two steps', () => {
    const s = verify({ kind: 'process', steps: [...lockSteps.slice(0, 2), { label: 'Ship rises 40 metres' }, { label: 'Pilots board by helicopter' }] });
    assert.deepEqual(s.diagram?.steps.map((x) => x.label), ['Ship enters the chamber', 'Lake water flows in']);
    assert.equal(verify({ kind: 'process', steps: [lockSteps[0], { label: 'Tolls are paid online' }] }).visual_type, 'stock');
  });

  it('needs a grounded centre for a breakdown', () => {
    assert.equal(verify({ kind: 'breakdown', center: 'Canal lock', steps: lockSteps.slice(0, 3) }).visual_type, 'stock', 'centre not in the narration');
    assert.equal(verify({ kind: 'breakdown', center: 'The chamber', steps: lockSteps.slice(0, 3) }).visual_type, 'diagram');
  });

  it('keeps only as many steps as the narration gives time to read', () => {
    const shot: ShotPlan = { visual_type: 'diagram', visual_query: 'x', covers: 'a', word_start: 0, word_count: 8, diagram: { kind: 'process', steps: lockSteps.map((s) => ({ label: s.label })) } };
    const [fitted] = fitGraphicsToTime(beat, [shot]);
    assert.equal(fitted.visual_type, 'diagram');
    assert.equal(fitted.diagram?.steps.length, 2);
    const [tooShort] = fitGraphicsToTime(beat, [{ ...shot, word_count: 4 }]);
    assert.equal(tooShort.visual_type, 'stock');
  });
});

describe('Diagram rendering', () => {
  const spec: DiagramSpec = { kind: 'process', title: 'How a lock lifts a ship', steps: lockSteps.map((s) => ({ label: s.label })) };

  it('reveals each step as the narration reaches it, in order and spaced out', () => {
    const times = diagramRevealTimes(spec, narration, 8);
    assert.equal(times.length, 4);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1] + 0.45, times.join(', '));
    assert.ok(times[3] <= 8 * 0.8, 'all steps appear by 80% of the shot');
    // "rises" comes late in the narration; "enters" early
    assert.ok(times[0] < 1 && times[2] > 3, times.join(', '));
  });

  it('keeps every layout inside the frame', () => {
    for (const kind of ['process', 'cycle', 'breakdown'] as const) {
      for (let n = 2; n <= 5; n++) {
        const s: DiagramSpec = { kind, title: 'T', center: 'C', steps: Array.from({ length: n }, (_, i) => ({ label: `Step ${i}` })) };
        const { cards, links } = diagramLayout(s);
        assert.equal(cards.length, n);
        for (const c of cards) {
          assert.ok(c.x >= 20 && c.y >= 180 && c.x + c.w <= 1900 && c.y + c.h <= 1060, `${kind} ${n}: ${JSON.stringify(c)}`);
        }
        assert.equal(links.length, kind === 'process' ? n - 1 : n);
      }
    }
  });

  it('escapes text and starts with no arrowheads drawn', () => {
    const html = diagramTemplate(themeForStyle('vox_explainer'), { kind: 'process', steps: [{ label: 'A <b>' }, { label: 'B & C' }] }, [0.5, 1.5]);
    assert.match(html, /A &lt;b&gt;/);
    assert.match(html, /B &amp; C/);
    assert.doesNotMatch(html, /<path id="l\d+"[^>]*marker-end/);
  });

  it('cues a tick on every step reveal', () => {
    const shot: ShotPlan = { visual_type: 'diagram', visual_query: 'x', covers: narration, word_start: 0, word_count: 26, diagram: spec };
    const cues = shotCues({ renderedType: 'diagram', durationSec: 8, plan: shot });
    const ticks = cues.filter((c) => c.sound === 'tick').map((c) => c.at);
    assert.deepEqual(ticks, diagramRevealTimes(spec, narration, 8));
  });

  it('cues a whoosh when an annotation ring draws on', () => {
    const cues = shotCues({ renderedType: 'archive', durationSec: 5, note: 'relevance 8/10; annotated: Gatun Locks' });
    assert.equal(cues.length, 1);
    assert.equal(cues[0].sound, 'whoosh');
  });
});
