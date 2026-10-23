import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addToOvernightQueue,
  inOvernightWindow,
  readOvernightQueue,
  releaseOvernightQueue,
  removeFromOvernightQueue,
  setOvernightWindow,
} from '../../src/pipeline/runner/overnight.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const at = (h: number, m = 0) => new Date(2026, 9, 23, h, m);
let dir: string;

function db() {
  return createMockSupabase({
    videos: [
      { id: 'v-ready', title: 'Ready', status: 'voiced', script_json: { beats: [{ index: 0, text: 'One.' }] } },
      { id: 'v-missing', title: 'Missing', status: 'voiced', script_json: { beats: [{ index: 0, text: 'One.' }, { index: 1, text: 'Two.' }] } },
    ],
    video_assets: [
      { video_id: 'v-ready', beat_index: 0, visual_type: 'uploaded', source_url: 'x.png' },
      { video_id: 'v-missing', beat_index: 0, visual_type: 'uploaded', source_url: 'x.png' },
    ],
    yt_jobs: [],
  });
}

describe('Overnight render queue', () => {
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overnight-'));
    process.env.OVERNIGHT_QUEUE_FILE = path.join(dir, 'queue.json');
  });
  after(async () => {
    delete process.env.OVERNIGHT_QUEUE_FILE;
  });

  it('knows when the window is open, across midnight and within a day', () => {
    const night = { start: '23:00', end: '07:00' };
    assert.equal(inOvernightWindow(at(23, 30), night), true);
    assert.equal(inOvernightWindow(at(3), night), true);
    assert.equal(inOvernightWindow(at(7), night), false);
    assert.equal(inOvernightWindow(at(14), night), false);
    const lunch = { start: '12:00', end: '14:00' };
    assert.equal(inOvernightWindow(at(13), lunch), true);
    assert.equal(inOvernightWindow(at(14), lunch), false);
  });

  it('holds renders until the window opens, then queues each as an ordinary assembly job', async () => {
    const { supabase, db: tables } = db();
    await addToOvernightQueue('v-ready', 'Ready');
    await addToOvernightQueue('v-ready', 'Ready');
    assert.equal((await readOvernightQueue()).items.length, 1, 'added once');

    assert.deepEqual(await releaseOvernightQueue(supabase, { now: at(15) }), { started: [], failed: [] });
    assert.equal(tables.yt_jobs.length, 0, 'nothing runs in the day');

    const res = await releaseOvernightQueue(supabase, { now: at(23, 5) });
    assert.deepEqual(res.started, ['v-ready']);
    assert.equal(tables.yt_jobs.length, 1);
    assert.equal(tables.yt_jobs[0].status, 'queued');
    assert.deepEqual(tables.yt_jobs[0].stages, ['assembly']);
    assert.equal(tables.videos.find((v) => v.id === 'v-ready')?.status, 'rendering');
    assert.equal((await readOvernightQueue()).items.length, 0, 'started renders leave the queue');
  });

  it('keeps a render that cannot start, with the reason, and waits before trying it again', async () => {
    const { supabase, db: tables } = db();
    await addToOvernightQueue('v-missing', 'Missing');
    const res = await releaseOvernightQueue(supabase, { now: at(23, 5) });
    assert.deepEqual(res.failed, ['v-missing']);
    const [item] = (await readOvernightQueue()).items;
    assert.match(item.lastError ?? '', /beat|asset/i);
    assert.deepEqual(await releaseOvernightQueue(supabase, { now: at(23, 6) }), { started: [], failed: [] }, 'not retried every minute');

    tables.video_assets.push({ video_id: 'v-missing', beat_index: 1, visual_type: 'uploaded', source_url: 'y.png' });
    assert.deepEqual((await releaseOvernightQueue(supabase, { now: at(23, 7), force: true })).started, ['v-missing'], 'Start all now ignores the wait');
  });

  it('saves the hours, refuses bad times, and removes renders', async () => {
    await setOvernightWindow('22:30', '06:00');
    assert.deepEqual((await readOvernightQueue()).window, { start: '22:30', end: '06:00' });
    await assert.rejects(setOvernightWindow('25:00', '06:00'), /HH:MM/);
    await addToOvernightQueue('a', 'A');
    await addToOvernightQueue('b', 'B');
    await removeFromOvernightQueue('a');
    assert.deepEqual((await readOvernightQueue()).items.map((i) => i.videoId), ['b']);
  });
});
