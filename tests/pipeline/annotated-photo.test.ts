import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyShot, repairRhythm } from '../../src/lib/script/shot-planner.ts';
import { annotatedPhotoTemplate, isUsableBox, locateTarget } from '../../src/pipeline/visuals/annotated-photo.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import type { ScriptBeat, ShotPlan } from '../../src/lib/script/generate-script.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';

const execFileAsync = promisify(execFile);

const beat = (index: number, text: string, shots?: ShotPlan[]): ScriptBeat => ({
  index,
  text,
  visual_type: 'archive',
  visual_query: 'q',
  duration_estimate_seconds: 5,
  shots,
});

describe('Annotation planning', () => {
  const b = beat(0, 'The Gatun Locks opened in 1914 and lift ships 26 metres.');
  const shot = (annotation: { target: string; label: string; detail?: string | null }) =>
    verifyShot({ visual_type: 'archive', covers: '', visual_query: 'Gatun Locks 1913', annotation }, b, []);

  it('keeps an annotation whose label the narration names, with a grounded detail', () => {
    const s = shot({ target: 'the lock gates', label: 'Gatun Locks', detail: 'opened 1914' });
    assert.deepEqual(s.annotation, { target: 'the lock gates', label: 'Gatun Locks', detail: 'opened 1914' });
  });

  it('drops an invented label, and a detail with an unstated figure', () => {
    assert.equal(shot({ target: 'the gates', label: 'Miraflores Locks' }).annotation, null);
    assert.equal(shot({ target: 'the gates', label: 'Gatun Locks', detail: 'cost $23 million' }).annotation?.detail, null);
  });

  it('spaces annotated photos out', () => {
    const annotated = (i: number): ShotPlan => ({
      visual_type: 'archive',
      visual_query: `photo ${i}`,
      covers: 'a b c d e',
      word_start: 0,
      word_count: 5,
      annotation: { target: 'x', label: 'Gatun Locks' },
    });
    const { beats } = repairRhythm([0, 1, 2, 3].map((i) => beat(i, 'a b c d e', [annotated(i)])));
    assert.deepEqual(beats.map((x) => Boolean(x.shots![0].annotation)), [true, false, false, true]);
  });
});

describe('Annotated photo rendering', () => {
  it('only accepts boxes that pick out one part of the photo', () => {
    assert.ok(isUsableBox([391, 466, 734, 526]));
    assert.ok(!isUsableBox([0, 0, 0, 0]), 'not found');
    assert.ok(!isUsableBox([500, 500, 510, 510]), 'a speck');
    assert.ok(!isUsableBox([0, 0, 1000, 900]), 'most of the photo');
    assert.ok(!isUsableBox([10, 20, 30]), 'malformed');
  });

  it('asks the vision model to confirm the label fits, and needs both answers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'annot-'));
    try {
      const photo = path.join(dir, 'photo.jpg');
      await execFileAsync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=gray:s=1600x1000', '-frames:v', '1', photo]);
      const prompts: string[] = [];
      const llm = (answer: Record<string, unknown>): LLMProvider => ({
        kind: 'llm',
        id: 'mock',
        supportsVision: true,
        generateText: async () => ({ text: '', usage: {} }),
        generateJson: async (req) => {
          prompts.push(req.prompt);
          assert.equal(req.images?.length, 1);
          return { data: answer as never, usage: {} };
        },
      });
      const ann = { target: 'the lock gates', label: 'Gatun Locks' };
      const box = [300, 400, 600, 700];
      assert.deepEqual(await locateTarget(photo, ann, llm({ found: true, label_fits: true, box, reason: '' }), { apiKey: 'k' }, 'Gatun 1913'), box);
      assert.equal(await locateTarget(photo, ann, llm({ found: true, label_fits: false, box, reason: 'other locks' }), { apiKey: 'k' }), null);
      assert.match(prompts[0], /honestly be labelled "Gatun Locks"/);
      assert.match(prompts[0], /titled "Gatun 1913"/);
      assert.deepEqual(await fs.readdir(dir), ['photo.jpg'], 'the vision copy is cleaned up');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('builds a page with the ring, dimming, leader line and escaped label', () => {
    const html = annotatedPhotoTemplate(
      themeForStyle('vox_explainer'),
      { imageUrl: 'data:image/jpeg;base64,AAAA', width: 1600, height: 1000 },
      [300, 400, 600, 700],
      { target: 'x', label: 'Locks <&> Dams', detail: 'opened 1914' },
    );
    assert.match(html, /<ellipse id="el"/);
    assert.match(html, /<path id="dim"/);
    assert.match(html, /<line id="ln"/);
    assert.match(html, /Locks &lt;&amp;&gt; Dams/);
    assert.match(html, /window\.__frame=/);
  });
});
