import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { bulkChanges, bulkCounts, isActive, readBulkStatus, startBulkFix } from '../../src/pipeline/vibedit/bulk-fix.ts';
import { buildEditContext, listSnapshots, restoreSnapshot } from '../../src/pipeline/vibedit/chat-editor.ts';
import { shotClipPath, sidecarPath } from '../../src/pipeline/visuals/shot-editor.ts';
import { rendersDir } from '../../src/pipeline/publish/publish-assets.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const shot = (type: string, query: string, extra: Record<string, unknown> = {}) => ({
  clipPath: '',
  renderedType: type,
  plannedType: type,
  startSec: 0,
  durationSec: 3,
  frames: 90,
  plan: { visual_type: type, visual_query: query, covers: 'what is said here', word_start: 0, word_count: 4 },
  ...extra,
});

describe('Vibedit bulk fixes', () => {
  const videoId = `test-bulk-${Date.now()}`;
  let dir: string;
  let tracks: string[];

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bulk-'));
    const shotsByBeat = [
      [shot('stock', 'harbour', { fallback: true }), shot('kinetic_text', 'The docks went quiet')],
      [shot('title', 'Chapter two'), shot('stock', 'warehouse', { note: 'unchecked relevance' })],
    ];
    tracks = shotsByBeat.map((_, i) => path.join(dir, `beat_${i}_track.mp4`));
    for (const [i, shots] of shotsByBeat.entries()) {
      await fs.writeFile(tracks[i], `track ${i} v1`);
      await fs.writeFile(sidecarPath(tracks[i]), JSON.stringify({ beatIndex: i, leadInSec: 0, tailSec: 0, shots }));
      for (const n of shots.keys()) {
        await fs.mkdir(path.dirname(shotClipPath(tracks[i], i, n)), { recursive: true });
        await fs.writeFile(shotClipPath(tracks[i], i, n), `beat ${i} shot ${n} v1`);
      }
    }
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(rendersDir(videoId), { recursive: true, force: true });
  });

  function db() {
    const id = `bulk-llm-${Math.random().toString(36).slice(2)}`;
    const llm: LLMProvider = {
      kind: 'llm',
      id,
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () =>
        ({
          data: {
            shots: [
              { id: '0:1', query: 'empty docks at dusk', archive: true },
              { id: '1:0', query: 'harbour cranes at work', archive: false },
              { id: '9:9', query: 'not a shot' },
            ],
          },
          usage: {},
        }) as never,
    };
    registerProvider('llm', id, llm);
    return createMockSupabase({
      videos: [{ id: videoId, style: 'history', script_json: { beats: [{ text: 'The docks went quiet.' }, { text: 'Chapter two.' }] } }],
      video_assets: tracks.map((t, i) => ({ id: `a${i}`, video_id: videoId, beat_index: i, visual_type: 'composite', source_url: t })),
      yt_jobs: [],
      yt_provider_configs: [{ id: `cfg-${id}`, kind: 'llm', provider: id, label: id, is_active: true }],
      yt_stage_bindings: [{ stage: 'script', provider_config_id: `cfg-${id}`, max_retries: 0 }],
    });
  }

  it('counts and lists what each fix would change', async () => {
    const { supabase } = db();
    const context = await buildEditContext(supabase, videoId);
    assert.deepEqual(bulkCounts(context), { flagged: 2, text_cards: 2 });
    assert.deepEqual((await bulkChanges(supabase, context, 'flagged')).map((c) => [c.beat, c.shot, c.action]), [[0, 0, 'redo'], [1, 1, 'redo']]);
    const cards = await bulkChanges(supabase, context, 'text_cards');
    assert.deepEqual(
      cards.map((c) => [c.beat, c.shot, c.action, c.query, c.archive]),
      [
        [0, 1, 'footage', 'empty docks at dusk', true],
        [1, 0, 'footage', 'harbour cranes at work', false],
      ],
    );
  });

  it('runs in the background with progress, one at a time, and undoes in one go', async () => {
    const { supabase } = db();
    const seen: string[] = [];
    const fakeEdit = (async ({ beat, shotIndex }: { beat: { beatIndex: number; trackPath: string }; shotIndex: number }) => {
      seen.push(`${beat.beatIndex}:${shotIndex}`);
      if (beat.beatIndex === 1) throw new Error('nothing better found');
      await fs.writeFile(shotClipPath(beat.trackPath, beat.beatIndex, shotIndex), 'changed');
      return { renderedType: 'stock' };
    }) as never;

    const { status, finished } = await startBulkFix(supabase, videoId, 'flagged', { edit: fakeEdit });
    assert.equal(status.state, 'planning');
    await assert.rejects(startBulkFix(supabase, videoId, 'text_cards'), /already running/);
    await finished;

    const done = (await readBulkStatus(videoId))!;
    assert.deepEqual([done.state, done.total, done.done, done.failed], ['done', 2, 1, 1]);
    assert.deepEqual(seen, ['0:0', '1:1']);
    assert.equal(await fs.readFile(shotClipPath(tracks[0], 0, 0), 'utf-8'), 'changed');
    assert.equal((await listSnapshots(videoId))[0].label, 'Bulk fix: redo every flagged shot');

    await restoreSnapshot(supabase, videoId, done.snapshotId!);
    assert.equal(await fs.readFile(shotClipPath(tracks[0], 0, 0), 'utf-8'), 'beat 0 shot 0 v1');
  });

  it('no longer blocks once a run has been silent too long (the server restarted)', () => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    const base = { kind: 'flagged' as const, total: 3, done: 1, failed: 0, startedAt: '2026-10-23T11:00:00Z' };
    assert.equal(isActive({ ...base, state: 'running', updatedAt: '2026-10-23T11:55:00Z' }, now), true);
    assert.equal(isActive({ ...base, state: 'running', updatedAt: '2026-10-23T11:30:00Z' }, now), false);
    assert.equal(isActive({ ...base, state: 'done', updatedAt: '2026-10-23T11:59:00Z' }, now), false);
  });
});
