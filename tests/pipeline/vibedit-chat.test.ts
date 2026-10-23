import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyChatPlan,
  buildEditContext,
  buildPlanPrompt,
  listSnapshots,
  MAX_CHANGES,
  normalizePlan,
  planChatEdit,
  requestScope,
  restoreSnapshot,
  sameSearch,
} from '../../src/pipeline/vibedit/chat-editor.ts';
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
  plan: { visual_type: type, visual_query: query, covers: 'the narration here', word_start: 0, word_count: 4 },
  ...extra,
});

describe('Vibedit chat editor (visuals)', () => {
  const videoId = `test-chat-${Date.now()}`;
  let dir: string;
  let tracks: string[];

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-'));
    tracks = [0, 1, 2].map((i) => path.join(dir, `beat_${i}_track.mp4`));
    const shotsByBeat = [
      [shot('stock', 'harbour at dawn'), shot('kinetic_text', 'The docks went quiet')],
      [shot('kinetic_text', 'Strike!'), shot('chart', 'tonnage by year'), shot('stock', 'empty warehouse', { fallback: true })],
      [shot('archive', '1926 dock workers')],
    ];
    for (const [i, shots] of shotsByBeat.entries()) {
      await fs.writeFile(tracks[i], `track ${i} v1`);
      await fs.writeFile(sidecarPath(tracks[i]), JSON.stringify({ beatIndex: i, leadInSec: 0, tailSec: 0, shots }));
      for (const n of shots.keys()) {
        const clip = shotClipPath(tracks[i], i, n);
        await fs.mkdir(path.dirname(clip), { recursive: true });
        await fs.writeFile(clip, `beat ${i} shot ${n} v1`);
      }
    }
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(rendersDir(videoId), { recursive: true, force: true });
  });

  function db(respond?: (prompt: string) => unknown) {
    const id = `chat-llm-${Math.random().toString(36).slice(2)}`;
    if (respond) {
      const llm: LLMProvider = {
        kind: 'llm',
        id,
        generateText: async () => ({ text: '', usage: {} }),
        generateJson: async (req) => ({ data: respond(req.prompt), usage: {} }) as never,
      };
      registerProvider('llm', id, llm);
    }
    return createMockSupabase({
      videos: [
        {
          id: videoId,
          style: 'history',
          script_json: {
            beats: [{ text: 'Dawn at the harbour.' }, { text: 'Then came the strike.' }, { text: 'The men walked out.' }, { text: 'A plain beat.' }],
            sections: { sections: [{ start_beat: 0, title: 'Before' }, { start_beat: 1, title: 'The strike' }] },
            timeline: { beats: [{ index: 1, sceneStartMs: 65_000 }] },
          },
        },
      ],
      video_assets: [
        ...tracks.map((t, i) => ({ id: `a${i}`, video_id: videoId, beat_index: i, visual_type: 'composite', source_url: t, license_type: 'mixed' })),
        { id: 'a3', video_id: videoId, beat_index: 3, visual_type: 'uploaded', source_url: 'x.png' },
      ],
      yt_jobs: [],
      ...(respond
        ? {
            yt_provider_configs: [{ id: `cfg-${id}`, kind: 'llm', provider: id, label: id, is_active: true }],
            yt_stage_bindings: [{ stage: 'script', provider_config_id: `cfg-${id}`, max_retries: 0 }],
          }
        : {}),
    });
  }

  it('shows the model every editable shot, numbered from 1 as the creator sees them', async () => {
    const { supabase } = db();
    const context = await buildEditContext(supabase, videoId);
    assert.equal(context.beats[1].chapter, 2);
    assert.equal(context.beats[3].shots, null, 'an uploaded beat is not editable shot by shot');
    const prompt = buildPlanPrompt(context, 'replace the text cards in chapter 2', []);
    assert.match(prompt, /Beat 2 \(chapter 2 "The strike" at 1:05\): Then came the strike\./);
    assert.match(prompt, /shot 1: kinetic_text \(text, 3s\) shows "Strike!"/);
    assert.match(prompt, /shot 3: stock \(footage, 3s\) \[FLAGGED/);
    assert.match(prompt, /Beat 4 .*\n {2}\(one visual, not editable here\)/);
  });

  it('keeps only real shots, once each, footage with a query, within the cap', async () => {
    const { supabase } = db();
    const context = await buildEditContext(supabase, videoId);
    const plan = normalizePlan(
      {
        reply: ' Swapping two. ',
        changes: [
          { beat: 1, shot: 0, action: 'footage', query: 'dock strike crowd 1926', archive: true, reason: 'text card' },
          { beat: 1, shot: 0, action: 'redo' },
          { beat: 1, shot: 9, action: 'redo' },
          { beat: 3, shot: 0, action: 'redo' },
          { beat: 0, shot: 1, action: 'footage', query: '  ' },
          { beat: 2, shot: 0, action: 'text', query: 'ignored' },
        ],
      },
      context,
    );
    assert.equal(plan.reply, 'Swapping two.');
    assert.deepEqual(
      plan.changes.map((c) => [c.beat, c.shot, c.action, c.query ?? null]),
      [
        [1, 0, 'footage', 'dock strike crowd 1926'],
        [2, 0, 'text', null],
      ],
    );
    assert.equal(plan.changes[0].now, 'kinetic_text: Strike!');
    const many = normalizePlan({ reply: '', changes: Array.from({ length: 30 }, (_, k) => ({ beat: k % 3, shot: 0, action: 'redo' as const })) }, context);
    assert.ok(many.changes.length <= MAX_CHANGES);
  });

  it('holds the plan to what the request names: chapters, beats, text cards; same search is a redo', async () => {
    assert.deepEqual([...(requestScope('replace the text cards in chapter 2 with footage').chapters ?? [])], [2]);
    assert.equal(requestScope('replace the text cards in chapter 2').textOnly, true);
    assert.deepEqual([...(requestScope('beats 3-5 and beat 9').beats ?? [])].sort((a, b) => a - b), [2, 3, 4, 8]);
    assert.deepEqual(requestScope('make it moodier'), {});

    const { supabase } = db();
    const context = await buildEditContext(supabase, videoId);
    const plan = normalizePlan(
      {
        reply: '',
        changes: [
          { beat: 1, shot: 0, action: 'footage', query: 'strike crowd' },
          { beat: 1, shot: 1, action: 'footage', query: 'cargo cranes' },
          { beat: 0, shot: 1, action: 'footage', query: 'quiet docks' },
        ],
      },
      context,
      'replace the text cards in chapter 2 with footage',
    );
    assert.deepEqual(plan.changes.map((c) => [c.beat, c.shot]), [[1, 0]], 'the chart is not a text card, and beat 1 is in chapter 1');

    const same = normalizePlan({ reply: '', changes: [{ beat: 0, shot: 0, action: 'footage', query: 'Harbour at dawn!' }] }, context, 'better shot for beat 1');
    assert.deepEqual([same.changes[0].action, same.changes[0].query], ['redo', undefined]);
    assert.equal(sameSearch('young football player dribbling ball on training pitch', 'young football player dribbling ball, training pitch'), true);
    assert.equal(sameSearch('dock strike crowd 1926', 'harbour at dawn'), false);
  });

  it('plans from a request, turning the model\'s 1-based numbers into the video\'s', async () => {
    let seen = '';
    const { supabase } = db((prompt) => {
      seen = prompt;
      return { reply: 'I will swap the strike card for archive film.', changes: [{ beat: 2, shot: 1, action: 'footage', query: 'dock strike 1926', archive: true, reason: 'card' }] };
    });
    const plan = await planChatEdit(supabase, videoId, 'use real film instead of the Strike! card', [{ role: 'user', text: 'hello' }]);
    assert.match(seen, /Request: use real film instead of the Strike! card/);
    assert.match(seen, /Creator: hello/);
    assert.deepEqual([plan.changes[0].beat, plan.changes[0].shot, plan.changes[0].archive], [1, 0, true]);
  });

  it('applies a plan after snapshotting, reports a failed shot, and undoes everything', async () => {
    const { supabase, db: tables } = db();
    const context = await buildEditContext(supabase, videoId);
    const plan = normalizePlan(
      {
        reply: '',
        changes: [
          { beat: 1, shot: 0, action: 'footage', query: 'dock strike 1926', archive: true },
          { beat: 1, shot: 2, action: 'redo' },
          { beat: 0, shot: 1, action: 'text' },
        ],
      },
      context,
    );
    const calls: string[] = [];
    const fakeEdit = (async ({ beat, shotIndex, edit }: { beat: { beatIndex: number; trackPath: string }; shotIndex: number; edit: { action: string; query?: string } }) => {
      calls.push(`${beat.beatIndex}:${shotIndex}:${edit.action}${edit.query ? `:${edit.query}` : ''}`);
      if (beat.beatIndex === 1 && shotIndex === 2) throw new Error('no footage found');
      await fs.writeFile(shotClipPath(beat.trackPath, beat.beatIndex, shotIndex), 'changed');
      await fs.writeFile(beat.trackPath, 'track changed');
      tables.video_assets.find((a) => a.beat_index === beat.beatIndex)!.license_type = 'changed';
      return { renderedType: edit.action === 'text' ? 'kinetic_text' : 'archive', note: 'test' };
    }) as never;

    const { snapshotId, results } = await applyChatPlan(supabase, videoId, plan.changes, 'swap the strike card', { edit: fakeEdit });
    assert.deepEqual(calls, ['1:0:footage:dock strike 1926', '1:2:redo', '0:1:text']);
    assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
    assert.match(results[1].error ?? '', /no footage found/);
    assert.equal(await fs.readFile(tracks[1], 'utf-8'), 'track changed');

    const listed = await listSnapshots(videoId);
    assert.equal(listed[0].id, snapshotId);
    assert.deepEqual(listed[0].beats, [0, 1]);
    assert.equal(listed[0].label, 'swap the strike card');

    assert.deepEqual(await restoreSnapshot(supabase, videoId, snapshotId), [0, 1]);
    assert.equal(await fs.readFile(tracks[1], 'utf-8'), 'track 1 v1');
    assert.equal(await fs.readFile(shotClipPath(tracks[1], 1, 0), 'utf-8'), 'beat 1 shot 0 v1');
    assert.equal(await fs.readFile(shotClipPath(tracks[0], 0, 1), 'utf-8'), 'beat 0 shot 1 v1');
    assert.equal(tables.video_assets.find((a) => a.beat_index === 1)!.license_type, 'mixed', 'the credits are back too');
    assert.deepEqual(await listSnapshots(videoId), [], 'an undone edit leaves the list');
    await assert.rejects(restoreSnapshot(supabase, videoId, snapshotId), /no longer be undone/);
  });
});
