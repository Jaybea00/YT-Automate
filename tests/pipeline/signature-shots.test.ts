import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { finalizeBeatShots, planShotsWith, verifyShot } from '../../src/lib/script/shot-planner.ts';
import { motionPageFor } from '../../src/pipeline/visuals/motion-shots.ts';
import { renderMotionClip } from '../../src/pipeline/visuals/motion/frame-renderer.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { shotCues } from '../../src/pipeline/assembly/sound-design.ts';
import { STYLE_PACKS } from '../../src/lib/styles/packs.ts';
import type { GeneratedScript, ScriptBeat, ShotPlan } from '../../src/lib/script/generate-script.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import type { ResearchFact } from '../../src/lib/research/types.ts';

const beat = (text: string, extra: Partial<ScriptBeat> = {}): ScriptBeat => ({
  index: 0,
  text,
  visual_type: 'stock',
  visual_query: 'q',
  duration_estimate_seconds: 8,
  ...extra,
});
const facts: ResearchFact[] = [
  { id: 'F1', claim: 'The Tesla Model S Plaid reaches 60 mph in 2.1 seconds and the Porsche 911 Turbo S in 2.6 seconds.', sourceIds: ['S1'] },
  { id: 'F2', claim: 'In a letter of 2 July 1914 Franz Joseph wrote: "The crime against my nephew is the direct consequence of agitation."', sourceIds: ['S1'] },
];

describe('Signature shots: grounding', () => {
  it('keeps a pitch move with real names and on-pitch positions, and drops what is off the pitch', () => {
    const b = beat('Silva slides it through and Balotelli finishes past De Gea for the opener.');
    const shot = verifyShot(
      {
        visual_type: 'pitch',
        covers: b.text,
        visual_query: 'Balotelli goal',
        pitch: {
          title: 'The opener',
          players: [
            { label: 'Balotelli', x: 70, y: 45, team: 'a', to: { x: 86, y: 50 } },
            { label: 'Rooney', x: 40, y: 40, team: 'b' },
            { label: '9', x: 60, y: 20, team: 'a' },
            { label: 'Silva', x: 150, y: 20, team: 'a' },
          ],
          ball: [{ x: 55, y: 30 }, { x: 80, y: 46 }, { x: 140, y: 48 }, { x: 99, y: 48 }],
          outcome: 'goal',
        },
      },
      b,
      [],
    );
    assert.equal(shot.visual_type, 'pitch');
    assert.deepEqual(shot.pitch!.players.map((p) => p.label), ['Balotelli', '9'], 'unnamed and off-pitch players are dropped');
    assert.equal(shot.pitch!.ball.length, 3);
    assert.equal(verifyShot({ visual_type: 'pitch', covers: '', visual_query: 'x', pitch: { players: [], ball: [{ x: 5, y: 5 }] } }, b, []).visual_type, 'stock');
  });

  it('keeps evidence boards built from the story, with valid string links', () => {
    const b = beat('Gavrilo Princip, nineteen, waited near the Latin Bridge. Who supplied the guns?');
    const shot = verifyShot(
      {
        visual_type: 'evidence_board',
        covers: b.text,
        visual_query: 'the plot',
        evidence: {
          title: 'The Sarajevo plot',
          items: [
            { kind: 'photo', label: 'Gavrilo Princip', detail: 'aged 19' },
            { kind: 'place', label: 'Latin Bridge' },
            { kind: 'note', label: 'Who supplied the guns?' },
            { kind: 'clipping', label: 'Aliens landed in Vienna' },
          ],
          links: [[0, 1], [1, 0], [0, 2], [2, 9]],
        },
      },
      b,
      [],
    );
    assert.equal(shot.visual_type, 'evidence_board');
    assert.deepEqual(shot.evidence!.items.map((i) => i.label), ['Gavrilo Princip', 'Latin Bridge', 'Who supplied the guns?']);
    assert.deepEqual(shot.evidence!.links, [[0, 1], [0, 2]], 'duplicates and out-of-range links dropped');
  });

  it('puts only quoted words on a letter', () => {
    const b = beat('Days later the old emperor wrote to the Kaiser.', { fact_ids: ['F2'] });
    const real = verifyShot(
      { visual_type: 'letter', covers: b.text, visual_query: 'letter', letter: { writer: 'Franz Joseph', recipient: 'Kaiser', date: '2 July 1914', text: 'The crime against my nephew is the direct consequence of agitation' } },
      b,
      facts,
    );
    assert.equal(real.visual_type, 'letter');
    assert.equal(real.letter!.date, '2 July 1914');
    const invented = verifyShot(
      { visual_type: 'letter', covers: b.text, visual_query: 'letter', letter: { writer: 'Franz Joseph', text: 'We must have war at once, whatever it costs us all' } },
      b,
      facts,
    );
    assert.notEqual(invented.visual_type, 'letter');
  });

  it('races only stated figures, and scales only stated sizes in one unit', () => {
    const b = beat('The Plaid does it in 2.1 seconds; the 911 Turbo S needs 2.6.', { fact_ids: ['F1'] });
    const race = verifyShot(
      { visual_type: 'race_bars', covers: b.text, visual_query: '0-60', race: { title: '0-60 mph', unit: 'seconds', lower_is_better: true, items: [{ label: 'Model S Plaid', value: 2.1 }, { label: '911 Turbo S', value: 2.6 }] } },
      b,
      facts,
    );
    assert.equal(race.visual_type, 'race_bars');
    const madeUp = verifyShot(
      { visual_type: 'race_bars', covers: b.text, visual_query: '0-60', race: { title: '0-60 mph', lower_is_better: true, items: [{ label: 'Plaid', value: 2.1 }, { label: 'Corvette', value: 2.9 }] } },
      b,
      facts,
    );
    assert.notEqual(madeUp.visual_type, 'race_bars');

    const space = beat('Earth is 12,742 km across; the Sun is 1,392,700 km, about 109 Earths.');
    const ok = verifyShot(
      { visual_type: 'scale', covers: space.text, visual_query: 'sizes', scale: { items: [{ label: 'Earth', size: 12742, unit: 'km' }, { label: 'Sun', size: 1392700, unit: 'km' }] } },
      space,
      [],
    );
    assert.equal(ok.visual_type, 'scale');
    const mixed = verifyShot(
      { visual_type: 'scale', covers: space.text, visual_query: 'sizes', scale: { items: [{ label: 'Earth', size: 12742, unit: 'km' }, { label: 'Sun', size: 1392700, unit: 'miles' }] } },
      space,
      [],
    );
    assert.notEqual(mixed.visual_type, 'scale', 'different units can not share a scale');
  });
});

describe('Signature shots: styles', () => {
  const b = beat('Silva slides it through and Balotelli finishes past De Gea for the opener.');
  const pitchShot = {
    visual_type: 'pitch' as const,
    covers: b.text,
    visual_query: 'Balotelli goal',
    pitch: { players: [{ label: 'Balotelli', x: 70, y: 45, team: 'a' as const }], ball: [{ x: 55, y: 30 }, { x: 99, y: 48 }], outcome: 'goal' as const },
  };

  it('gives each style its own signature shots', () => {
    assert.deepEqual(STYLE_PACKS.sport.signatureShots, ['pitch', 'race_bars']);
    assert.deepEqual(STYLE_PACKS.mystery.signatureShots, ['evidence_board']);
    assert.deepEqual(STYLE_PACKS.history.signatureShots, ['letter']);
    assert.equal(STYLE_PACKS.finance.chartCallouts, true);
  });

  it('turns a signature shot from another style into footage', () => {
    assert.equal(finalizeBeatShots(b, [pitchShot], [], { signature: ['pitch'] })[0].visual_type, 'pitch');
    assert.notEqual(finalizeBeatShots(b, [pitchShot], [], { signature: ['letter'] })[0].visual_type, 'pitch');
  });

  it('keeps chart callouts only where the style has them', () => {
    const cb = beat('The Dow hit 381 in September, then 230 by late October, the crash, and 198 by November.');
    const chart = {
      visual_type: 'chart' as const,
      covers: cb.text,
      visual_query: 'Dow',
      chart: { chart_type: 'line' as const, title: 'Dow Jones', labels: ['Sep', 'Oct', 'Nov'], values: [381, 230, 198], annotations: [{ index: 1, text: 'The crash' }, { index: 7, text: 'nope' }] },
    };
    assert.deepEqual(finalizeBeatShots(cb, [chart], [], { chartCallouts: true })[0].chart?.annotations, [{ index: 1, text: 'The crash' }]);
    assert.equal(finalizeBeatShots(cb, [chart], [])[0].chart?.annotations, undefined);
  });

  it('tells only the right style about its signature shots', async () => {
    const prompts: string[] = [];
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock-director',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async (req) => {
        prompts.push(req.prompt);
        return { data: { beats: [{ index: 0, shots: [pitchShot] }] }, usage: {} } as never;
      },
    };
    const script: GeneratedScript = { title_options: ['t'], beats: [b] };
    const sport = await planShotsWith(llm, { apiKey: 'k' }, script, 'Balotelli', { style: 'sport' });
    assert.match(prompts[0], /SIGNATURE SHOTS FOR THIS STYLE/);
    assert.match(prompts[0], /"pitch": a move or goal recreated/);
    assert.equal(sport.beats[0].shots?.[0].visual_type, 'pitch');
    const history = await planShotsWith(llm, { apiKey: 'k' }, script, 'Balotelli', { style: 'history' });
    assert.doesNotMatch(prompts[1], /"pitch": a move/);
    assert.match(prompts[1], /"letter": a historical letter/);
    assert.notEqual(history.beats[0].shots?.[0].visual_type, 'pitch');
  });
});

describe('Signature shots: rendering', () => {
  const plans: ShotPlan[] = [
    { visual_type: 'pitch', visual_query: 'x', covers: 'x', word_start: 0, word_count: 5, pitch: { players: [{ label: 'A', x: 10, y: 10, team: 'a' }], ball: [{ x: 10, y: 10 }, { x: 99, y: 50 }], outcome: 'goal' } },
    { visual_type: 'evidence_board', visual_query: 'x', covers: 'x', word_start: 0, word_count: 5, evidence: { items: [{ kind: 'photo', label: 'A' }, { kind: 'note', label: 'B' }, { kind: 'clipping', label: 'C' }], links: [[0, 1]] } },
    { visual_type: 'letter', visual_query: 'x', covers: 'x', word_start: 0, word_count: 5, letter: { writer: 'W', text: 'Five words of a letter' } },
    { visual_type: 'race_bars', visual_query: 'x', covers: 'x', word_start: 0, word_count: 5, race: { title: 'T', lower_is_better: true, items: [{ label: 'A', value: 2 }, { label: 'B', value: 3 }] } },
    { visual_type: 'scale', visual_query: 'x', covers: 'x', word_start: 0, word_count: 5, scale: { items: [{ label: 'A', size: 1, unit: 'km' }, { label: 'B', size: 100, unit: 'km' }] } },
  ];

  it('renders every signature shot without errors in the page', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signature-'));
    const browser = await chromium.launch({ headless: true });
    try {
      for (const plan of plans) {
        const html = motionPageFor(plan, themeForStyle('sport'));
        assert.ok(html, plan.visual_type);
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.setContent(html!);
        await page.evaluate(() => (window as unknown as { __frame: (t: number, d: number) => void }).__frame(1.5, 3));
        await page.close();
        assert.deepEqual(errors, [], `${plan.visual_type} has no script errors`);
      }
      const out = path.join(dir, 'race.mp4');
      await renderMotionClip({ html: motionPageFor(plans[3], themeForStyle('car'))!, durationSec: 1, outputPath: out, browser });
      assert.ok((await fs.stat(out)).size > 0);
    } finally {
      await browser.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('gives signature shots their sounds', () => {
    const at = (plan: ShotPlan, d: number) => shotCues({ renderedType: plan.visual_type, durationSec: d, plan } as never).map((c) => c.sound);
    assert.ok(at(plans[0], 4).includes('impact'), 'a goal lands');
    assert.equal(at(plans[1], 4).filter((s) => s === 'paper').length, 3, 'each clue pinned');
    assert.equal(at(plans[3], 4).filter((s) => s === 'tick').length, 2, 'each car finishes');
  });
});
