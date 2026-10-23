import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { verifyShot } from '../../src/lib/script/shot-planner.ts';
import { motionPageFor } from '../../src/pipeline/visuals/motion-shots.ts';
import { renderCandidateShot } from '../../src/pipeline/visuals/shot-renderers.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { tornPolygon } from '../../src/pipeline/visuals/motion/signature-templates-2.ts';
import { STYLE_PACKS } from '../../src/lib/styles/packs.ts';
import type { ScriptBeat, ShotPlan } from '../../src/lib/script/generate-script.ts';

const execFileAsync = promisify(execFile);
const beat = (text: string): ScriptBeat => ({ index: 0, text, visual_type: 'stock', visual_query: 'q', duration_estimate_seconds: 8 });

describe('More signature shots', () => {
  it('keeps a spec card of stated figures, and drops invented rows', () => {
    const b = beat('The Model S Plaid makes 1,020 horsepower, hits 60 mph in 2.1 seconds and tops out at 200 mph.');
    const shot = verifyShot(
      {
        visual_type: 'spec_card',
        covers: b.text,
        visual_query: 'specs',
        spec: {
          title: 'Model S Plaid',
          subject: 'Tesla',
          rows: [
            { label: 'Power', value: '1,020 hp' },
            { label: '0-60 mph', value: '2.1 s' },
            { label: 'Top speed', value: '200 mph' },
            { label: 'Range', value: '396 miles' },
          ],
        },
      },
      b,
      [],
    );
    assert.equal(shot.visual_type, 'spec_card');
    assert.deepEqual(shot.spec!.rows.map((r) => r.label), ['Power', '0-60 mph', 'Top speed'], 'the unstated range is dropped');
  });

  it('shows money only with stated amounts, growing up or shrinking down', () => {
    const b = beat('Invest $1,000 at 10% and in 36 years it becomes about $32,000.');
    const grow = verifyShot({ visual_type: 'money', covers: b.text, visual_query: 'growth', money: { kind: 'growth', from: 1000, to: 32000, currency: '$', label: '$1,000 at 10%' } }, b, []);
    assert.equal(grow.visual_type, 'money');
    const wrongWay = verifyShot({ visual_type: 'money', covers: b.text, visual_query: 'x', money: { kind: 'shrink', from: 1000, to: 32000, currency: '$', label: 'x' } }, b, []);
    assert.notEqual(wrongWay.visual_type, 'money');
    const invented = verifyShot({ visual_type: 'money', covers: b.text, visual_query: 'x', money: { kind: 'growth', from: 1000, to: 50000, currency: '$', label: 'x' } }, b, []);
    assert.notEqual(invented.visual_type, 'money');
  });

  it('gives car and tech spec cards, finance money, and Vox the collage look', () => {
    assert.deepEqual(STYLE_PACKS.car.signatureShots, ['race_bars', 'spec_card']);
    assert.deepEqual(STYLE_PACKS.finance.signatureShots, ['money']);
    assert.equal(STYLE_PACKS.vox_explainer.photoLook, 'collage');
  });

  it('renders spec cards and money without page errors', async () => {
    const plans: ShotPlan[] = [
      { visual_type: 'spec_card', visual_query: 'x', covers: 'x', word_start: 0, word_count: 5, spec: { title: 'T', rows: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }, { label: 'C', value: '3' }] } },
      { visual_type: 'money', visual_query: 'x', covers: 'x', word_start: 0, word_count: 5, money: { kind: 'growth', from: 1000, to: 32000, currency: '$', label: 'L' } },
      { visual_type: 'money', visual_query: 'x', covers: 'x', word_start: 0, word_count: 5, money: { kind: 'shrink', from: 100, to: 42, currency: '£', label: 'L' } },
    ];
    const browser = await chromium.launch({ headless: true });
    try {
      for (const plan of plans) {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.setContent(motionPageFor(plan, themeForStyle('finance'))!);
        await page.evaluate(() => (window as unknown as { __frame: (t: number, d: number) => void }).__frame(2, 3));
        await page.close();
        assert.deepEqual(errors, [], plan.visual_type);
      }
    } finally {
      await browser.close();
    }
  });

  it('tears the same edge for the same shot', () => {
    assert.equal(tornPolygon(3), tornPolygon(3));
    assert.notEqual(tornPolygon(3), tornPolygon(4));
  });

  it('shows a still photo as a paper collage in a collage style', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'collage-'));
    try {
      const photo = path.join(dir, 'p.jpg');
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=800x600', '-frames:v', '1', photo]);
      const shot = { visual_type: 'stock', visual_query: 'x', covers: 'x', word_start: 0, word_count: 5 } as ShotPlan;
      const out = path.join(dir, 'clip.mp4');
      const rendered = await renderCandidateShot(
        shot,
        { shot, startSec: 0, frames: 30 },
        out,
        { beatIndex: 0, downloadDir: dir, theme: themeForStyle('vox_explainer'), usedSources: new Set(), motionCounter: { next: 0 }, collage: { count: { next: 0 } } } as never,
        { id: 'u1', provider: 'uploaded', mediaType: 'image', title: 'p', thumbnailUrl: '', downloadUrl: photo, license: 'own_work' },
      );
      assert.match(rendered.note ?? '', /collage/);
      assert.equal(rendered.still, false);
      assert.ok((await fs.stat(out)).size > 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
