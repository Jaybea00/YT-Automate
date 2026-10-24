import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sourceLabel, sourceTagFor, withSourceTag } from '../../src/pipeline/visuals/source-tags.ts';
import { MOTION_RENDERERS } from '../../src/pipeline/visuals/motion-shots.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import type { ShotPlan } from '../../src/lib/script/generate-script.ts';

const execFileAsync = promisify(execFile);

const dossier = {
  sources: [
    { id: 'S1', title: 'UEFA stats', url: 'https://www.uefa.com/stats/player' },
    { id: 'S2', title: 'BBC Sport', url: 'https://www.bbc.co.uk/sport/football/123' },
    { id: 'S3', title: 'Balotelli', url: 'https://en.wikipedia.org/wiki/Mario_Balotelli' },
    { id: 'S4', title: 'Transfer fees', url: 'https://www.transfermarkt.co.uk/x' },
  ],
  facts: [
    { id: 'F1', claim: '2 goals', sourceIds: ['S1', 'S2'] },
    { id: 'F2', claim: 'born 1990', sourceIds: ['S3'] },
    { id: 'F3', claim: 'fee', sourceIds: ['S4', 'S1'] },
  ],
};

describe('Source tags', () => {
  it('names publishers from their addresses', () => {
    assert.equal(sourceLabel(dossier.sources[0]), 'UEFA');
    assert.equal(sourceLabel(dossier.sources[1]), 'BBC');
    assert.equal(sourceLabel(dossier.sources[2]), 'Wikipedia');
    assert.equal(sourceLabel(dossier.sources[3]), 'Transfermarkt');
    assert.equal(sourceLabel({ title: 'Annual report 2023', url: 'notes' }), 'Annual report 2023', 'a brief source without an address');
  });

  it('tags figure shots from the facts they cite, at most two publishers', () => {
    assert.equal(sourceTagFor({ visual_type: 'stat', fact_ids: ['F1'] }, dossier), 'Sources: UEFA, BBC');
    assert.equal(sourceTagFor({ visual_type: 'chart', fact_ids: ['F2'] }, dossier), 'Source: Wikipedia');
    assert.equal(sourceTagFor({ visual_type: 'chart', fact_ids: ['F3', 'F1'] }, dossier), 'Sources: Transfermarkt, UEFA');
    assert.equal(sourceTagFor({ visual_type: 'kinetic_text', fact_ids: ['F1'] }, dossier), null, 'only shots that show figures');
    assert.equal(sourceTagFor({ visual_type: 'stat', fact_ids: [] }, dossier), null);
    assert.equal(sourceTagFor({ visual_type: 'stat', fact_ids: ['F1'] }, null), null);
  });

  it('adds the tag to the page and fades it in on the frame clock', () => {
    const html = withSourceTag('<html><head></head><body><script>window.__frame=()=>{}</script></body></html>', 'Source: A&B $1', themeForStyle('finance'));
    assert.match(html, /<div class="src-tag">Source: A&amp;B \$1<\/div>/);
    assert.ok(html.indexOf('src-tag">') > html.indexOf('window.__frame=()=>{}'), 'after the page script, so it wraps its clock');
  });

  it('renders the tag into a stat shot', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srctag-'));
    try {
      const shot = { visual_type: 'stat', visual_query: '2 goals', covers: '', word_start: 0, word_count: 2, fact_ids: ['F1'], stat: { value: 2, label: 'goals in 16 minutes' } } as unknown as ShotPlan;
      const render = (file: string, tag: boolean) =>
        MOTION_RENDERERS.stat!(shot, { shot, startSec: 0, frames: 60 }, file, {
          beatIndex: 0,
          downloadDir: dir,
          theme: themeForStyle('sport'),
          usedSources: new Set(),
          motionCounter: { next: 0 },
          ...(tag ? { sourceTag: (s: ShotPlan) => sourceTagFor(s, dossier) } : {}),
        });
      const tagged = path.join(dir, 'tagged.mp4');
      const plain = path.join(dir, 'plain.mp4');
      await render(tagged, true);
      await render(plain, false);
      // The lower-left corner differs once the tag has faded in (frame 55), and not before it (frame 5)
      const corner = async (file: string, frame: number) => {
        const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),crop=420:60:60:990,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
        return stdout as Buffer;
      };
      const diff = (a: Buffer, b: Buffer) => a.reduce((n, v, i) => n + Math.abs(v - b[i]), 0) / a.length;
      assert.ok(diff(await corner(tagged, 5), await corner(plain, 5)) < 2, 'not there at first');
      assert.ok(diff(await corner(tagged, 55), await corner(plain, 55)) > 3, 'there once faded in');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
