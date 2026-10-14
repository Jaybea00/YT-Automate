import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { composeBeatTrack } from '../../src/pipeline/visuals/shot-composer.ts';
import { makeColorClip } from '../../src/pipeline/visuals/clips.ts';
import { loadComposedBeat, publicShot, replaceShot, shotClipPath, sidecarPath } from '../../src/pipeline/visuals/shot-editor.ts';
import type { ShotPlan } from '../../src/lib/script/generate-script.ts';

const execFileAsync = promisify(execFile);

async function frameCount(file: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
  return Number(stdout.trim().replace(/,$/, ''));
}

/** Just enough of the Supabase client for the editor: one video_assets row, writes recorded. */
function fakeDb(asset: Record<string, unknown> | null) {
  const writes: Array<Record<string, unknown>> = [];
  const from = (table: string) => {
    let op = 'select';
    let payload: Record<string, unknown> | null = null;
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      delete: () => ((op = 'delete'), q),
      update: (p: Record<string, unknown>) => ((op = 'update'), (payload = p), q),
      insert: (p: Record<string, unknown>) => ((op = 'insert'), (payload = p), q),
      maybeSingle: async () => ({ data: table === 'video_assets' && asset ? { id: 'asset-1', ...asset } : null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if ((op === 'update' || op === 'insert') && payload) {
          writes.push(payload);
          if (table === 'video_assets' && asset) Object.assign(asset, payload);
        }
        return Promise.resolve({ data: table === 'yt_jobs' ? [] : null, error: null }).then(resolve);
      },
    };
    return q;
  };
  return { client: { from } as never, writes };
}

const plan = (word_start: number, word_count: number, visual_query: string): ShotPlan => ({
  visual_type: 'stock',
  visual_query,
  covers: visual_query,
  word_start,
  word_count,
});

describe('Shot editor', () => {
  let dir: string;
  let trackPath: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shot-editor-'));
    const composed = await composeBeatTrack({
      beatIndex: 2,
      shots: [plan(0, 4, 'first'), plan(4, 4, 'second'), plan(8, 4, 'third')],
      words: null,
      audioDurationSec: 2.5,
      outputDir: dir,
      renderShot: async (slot, clipPath) => {
        await makeColorClip('#223344', slot.frames, clipPath);
        return { clipPath, renderedType: 'stock', license: 'royalty_free', sourceUrl: `https://stock.test/${slot.shot.visual_query}` };
      },
    });
    trackPath = composed.trackPath;
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('loads only beats composed from shots', async () => {
    const beat = await loadComposedBeat(fakeDb({ visual_type: 'composite', source_url: trackPath }).client, 'v1', 2);
    assert.equal(beat?.shots.length, 3);
    assert.equal(beat?.shots[1].plan.visual_query, 'second');
    assert.deepEqual(beat?.shots.map((s) => s.frames), [25, 25, 25]);
    assert.ok(!('clipPath' in publicShot(beat!.shots[0], 0)), 'no local paths go to the browser');

    assert.equal(await loadComposedBeat(fakeDb({ visual_type: 'stock', source_url: trackPath }).client, 'v1', 2), null);
    assert.equal(await loadComposedBeat(fakeDb(null).client, 'v1', 2), null);
  });

  it('replaces one shot at its exact length, re-joins the beat, and updates the credits', async () => {
    const db = fakeDb({ visual_type: 'composite', source_url: trackPath });
    const beat = (await loadComposedBeat(db.client, 'v1', 2))!;
    const before = await fs.readFile(shotClipPath(trackPath, 2, 0));

    const updated = await replaceShot({
      supabase: db.client,
      videoId: 'v1',
      beat,
      shotIndex: 1,
      render: async (slot, clipPath) => {
        assert.equal(slot.frames, 25, 'the replacement gets the same length');
        await makeColorClip('#aa2222', slot.frames, clipPath);
        return { clipPath, renderedType: 'archive', license: 'cc_by_sa', sourceUrl: 'https://commons.test/new', attribution: 'Photographer X' };
      },
    });

    assert.equal(updated.renderedType, 'archive');
    assert.equal(updated.plan.visual_query, 'second', 'the plan is kept for later edits');
    assert.equal(await frameCount(trackPath), 75, 'the beat keeps its length, so later cuts stay on the narration');
    assert.deepEqual(await fs.readFile(shotClipPath(trackPath, 2, 0)), before, 'other shots are untouched');

    const sidecar = JSON.parse(await fs.readFile(sidecarPath(trackPath), 'utf-8'));
    assert.equal(sidecar.shots[1].sourceUrl, 'https://commons.test/new');
    const credit = db.writes.find((w) => w.visual_type === 'composite');
    assert.equal(credit?.license_type, 'cc_by_sa', 'the strictest license wins');
    assert.equal(credit?.attribution_text, 'Photographer X');
  });

  it('leaves the beat untouched when the replacement fails', async () => {
    const db = fakeDb({ visual_type: 'composite', source_url: trackPath });
    const beat = (await loadComposedBeat(db.client, 'v1', 2))!;
    const sidecarBefore = await fs.readFile(sidecarPath(trackPath), 'utf-8');
    await assert.rejects(
      replaceShot({
        supabase: db.client,
        videoId: 'v1',
        beat,
        shotIndex: 0,
        render: async () => {
          throw new Error('download failed');
        },
      }),
      /download failed/,
    );
    assert.equal(await fs.readFile(sidecarPath(trackPath), 'utf-8'), sidecarBefore);
    assert.equal(db.writes.length, 0);
    await assert.rejects(fs.stat(shotClipPath(trackPath, 2, 0).replace(/\.mp4$/, '.new.mp4')), 'no temporary file left behind');
  });
});
