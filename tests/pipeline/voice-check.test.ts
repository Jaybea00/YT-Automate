import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildVoiceCheckPrompt,
  dropSpuriousAdditions,
  loadVoiceCheck,
  runVoiceCheck,
  voiceCheckPathFor,
} from '../../src/pipeline/tts/voice-check.ts';
import { saveWordTimings } from '../../src/pipeline/tts/word-timings.ts';
import { handleGetVoiceChecks, handleRunVoiceChecks } from '../../src/app/api/videos/[id]/voice/check/route.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const realFetch = globalThis.fetch;

function fakeGemini(reply: { transcript: string; issues: unknown[] }, log: Array<{ prompt: string; mime: string }> = []) {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    log.push({ prompt: body.contents[0].parts[1].text, mime: body.contents[0].parts[0].inlineData.mimeType });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }), { status: 200 });
  }) as typeof fetch;
  return log;
}

describe('Voice check', () => {
  let dir: string;
  let audio: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-check-'));
    audio = path.join(dir, 'tts_scene_0.mp3');
    await fs.writeFile(audio, Buffer.from('fake mp3 bytes'));
    await saveWordTimings(audio, {
      version: 1,
      source: 'provider',
      text: 'On Oct. 29 it fell.',
      spokenText: 'On October 29th it fell.',
      durationMs: 2000,
      words: [],
    });
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('checks against the text the voice was actually given and caches the result', async () => {
    const log = fakeGemini({ transcript: 'On October twenty-ninth it fell.', issues: [] });
    const first = await runVoiceCheck(audio, 'On Oct. 29 it fell.', { apiKey: 'k' });
    assert.equal(first.ok, true);
    assert.match(log[0].prompt, /"""On October 29th it fell\."""/);
    assert.equal(log[0].mime, 'audio/mpeg');

    await runVoiceCheck(audio, 'On Oct. 29 it fell.', { apiKey: 'k' });
    assert.equal(log.length, 1, 'second run reuses the saved check');
  });

  it('invalidates the saved check when the beat is re-voiced', async () => {
    fakeGemini({ transcript: 'x', issues: [] });
    await runVoiceCheck(audio, 'x', { apiKey: 'k' }, { force: true });
    assert.ok(await loadVoiceCheck(audio));
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(audio, Buffer.from('new take, different length'));
    assert.equal(await loadVoiceCheck(audio), null);
    await fs.rm(voiceCheckPathFor(audio), { force: true });
  });

  it('drops "added" reports for words the text contains, keeps real problems', () => {
    // From a live run: a genuinely skipped phrase plus a spurious "added: bid"
    const issues = dropSpuriousAdditions(
      [
        { type: 'skipped', expected: 'and the Rockefeller family', heard: null },
        { type: 'added', expected: null, heard: 'bid' },
        { type: 'added', expected: null, heard: 'um' },
      ],
      'J.P. Morgan bankers and the Rockefeller family bid for U.S. Steel',
    );
    assert.deepEqual(issues.map((i) => [i.type, i.heard ?? i.expected]), [
      ['skipped', 'and the Rockefeller family'],
      ['added', 'um'],
    ]);
  });

  it('tells the checker that spoken forms of numbers and initials are correct', () => {
    const prompt = buildVoiceCheckPrompt('In 1929 the U.S. lost $14 billion.');
    assert.match(prompt, /nineteen twenty-nine/);
    assert.match(prompt, /Ignore pacing/);
  });
});

describe('Voice check routes', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-check-route-'));
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('checks the latest voiced take of each beat and returns saved results on GET', async () => {
    const oldTake = path.join(dir, 'old_0.mp3');
    const newTake = path.join(dir, 'new_0.mp3');
    const beat1 = path.join(dir, 'new_1.mp3');
    for (const f of [oldTake, newTake, beat1]) await fs.writeFile(f, Buffer.from(f));

    const { supabase } = createMockSupabase({
      videos: [{ id: 'vid-check', script_json: { beats: [{ text: 'First beat.' }, { text: 'Second beat.' }] } }],
      yt_jobs: [
        { id: 'job-old', video_id: 'vid-check', created_at: '2026-10-01T00:00:00Z' },
        { id: 'job-new', video_id: 'vid-check', created_at: '2026-10-13T00:00:00Z' },
      ],
      yt_job_units: [
        { job_id: 'job-old', stage: 'tts', unit_index: 0, status: 'done', output_path: oldTake },
        { job_id: 'job-new', stage: 'tts', unit_index: 0, status: 'done', output_path: newTake },
        { job_id: 'job-new', stage: 'tts', unit_index: 1, status: 'done', output_path: beat1 },
      ],
      yt_provider_configs: [{ id: 'cfg', kind: 'llm', provider: 'gemini', label: 'g', is_active: true }],
      yt_stage_bindings: [{ stage: 'script', provider_config_id: 'cfg', max_retries: 0 }],
    });
    process.env.GEMINI_API_KEY ||= 'test-key';

    const log = fakeGemini({ transcript: 'First beat.', issues: [{ type: 'skipped', expected: 'beat', heard: null }] });
    const res = await handleRunVoiceChecks(new Request('http://x', { method: 'POST', body: '{}' }), 'vid-check', supabase);
    const json = await res.json();

    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(log.length, 2);
    assert.deepEqual(json.checks.map((c: any) => [c.beatIndex, c.result.ok]), [[0, false], [1, false]]);
    assert.ok(await loadVoiceCheck(newTake), 'newest take was checked');
    assert.equal(await loadVoiceCheck(oldTake), null, 'old take was not');

    const get = await (await handleGetVoiceChecks('vid-check', supabase)).json();
    assert.equal(get.checks.length, 2);
    assert.equal(get.voicedBeats, 2);
  });
});
