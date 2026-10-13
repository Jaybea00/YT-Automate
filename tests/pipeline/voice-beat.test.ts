import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mapWithConcurrency, resolveTtsSetup, ttsUnitInput, voiceBeat } from '../../src/pipeline/tts/voice-beat.ts';
import { loadWordTimings } from '../../src/pipeline/tts/word-timings.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { TTSProvider, TtsRequest } from '../../src/pipeline/providers/types.ts';
import { handleRegenTts } from '../../src/app/api/videos/[id]/beats/[index]/regen-tts/route.ts';
import { handleVoiceRequest } from '../../src/app/api/videos/[id]/voice/route.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);

describe('Voicing beats', () => {
  let tmp: string;
  let toneMp3: Uint8Array;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-beat-'));
    // 0.3s silence, 1s tone, 0.4s silence, 1s tone, 0.3s silence: two "phrases" with a pause
    const file = path.join(tmp, 'tone.mp3');
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=0.3',
      '-f', 'lavfi', '-i', 'sine=f=220:r=24000:d=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=0.4',
      '-f', 'lavfi', '-i', 'sine=f=220:r=24000:d=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=0.3',
      '-filter_complex', '[0][1][2][3][4]concat=n=5:v=0:a=1',
      '-c:a', 'libmp3lame', file,
    ]);
    toneMp3 = new Uint8Array(await fs.readFile(file));
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function mockTts(
    id: string,
    extra: { supportsDirection?: boolean; words?: Array<{ word: string; start: number; end: number }> } = {},
  ) {
    const requests: TtsRequest[] = [];
    const provider: TTSProvider = {
      kind: 'tts',
      id,
      requiresApiKey: false,
      supportsDirection: extra.supportsDirection,
      synthesize: async (req) => {
        requests.push(req);
        return { bytes: toneMp3, mimeType: 'audio/mpeg', usage: { characters: req.text.length }, words: extra.words };
      },
    };
    registerProvider('tts', id, provider);
    return { provider, requests };
  }

  function supabaseFor(providerId: string, extra: Record<string, unknown[]> = {}, options: Record<string, unknown> = {}) {
    return createMockSupabase({
      yt_provider_configs: [
        { id: `cfg-${providerId}`, kind: 'tts', provider: providerId, label: providerId, is_active: true, options: { voice: 'default_voice', ...options } },
      ],
      yt_stage_bindings: [{ stage: 'tts', provider_config_id: `cfg-${providerId}`, max_retries: 0 }],
      ...extra,
    });
  }

  it('only lets delivery direction change the checkpoint for voices that use it', async () => {
    mockTts('mock-plain-tts');
    mockTts('mock-directed-tts', { supportsDirection: true });

    const optedIn = { styleDirection: true };
    const plain = await resolveTtsSetup(supabaseFor('mock-plain-tts', {}, optedIn).supabase, { template: 'true_crime_pov', script: {} });
    const directed = await resolveTtsSetup(supabaseFor('mock-directed-tts', {}, optedIn).supabase, { template: 'true_crime_pov', script: {} });
    const defaultSetup = await resolveTtsSetup(supabaseFor('mock-directed-tts').supabase, { template: 'true_crime_pov', script: {} });

    assert.ok(plain.direction, 'style delivery resolved when the voice config opts in');
    assert.equal(defaultSetup.direction, undefined, 'plain narration by default');
    assert.equal('direction' in ttsUnitInput(plain, 'Hello there.').input, false);
    assert.equal(ttsUnitInput(directed, 'Hello there.').input.direction, directed.direction);
    assert.equal(ttsUnitInput(plain, 'On Oct. 29 it fell.').spokenText, 'On October 29th it fell.');
  });

  it('voices the speakable text and aligns provider timings to the written words', async () => {
    const { requests } = mockTts('mock-timed-tts', {
      words: [
        { word: 'On', start: 0.3, end: 0.5 },
        { word: 'October', start: 0.5, end: 0.9 },
        { word: 'twenty-ninth', start: 0.9, end: 1.3 },
        { word: 'it', start: 1.7, end: 1.9 },
        { word: 'fell', start: 1.9, end: 2.6 },
      ],
    });
    const { supabase } = supabaseFor('mock-timed-tts');
    const setup = await resolveTtsSetup(supabase, { template: 'tech', script: { voice_id: 'narrator_x' } });

    const result = await voiceBeat({ supabase, setup, jobId: 'job-v1', unitIndex: 0, narration: 'On Oct. 29 it fell.', outputDir: tmp });

    assert.equal(result.success, true);
    assert.equal(requests[0].text, 'On October 29th it fell.');
    assert.equal(requests[0].voiceId, 'narrator_x', 'the job narrator wins over the binding voice');
    const timings = await loadWordTimings(result.outputPath!);
    assert.equal(timings?.source, 'provider');
    assert.deepEqual(timings?.words.map((w) => w.word), ['On', 'Oct.', '29', 'it', 'fell.']);
    assert.deepEqual([timings!.words[1].start, timings!.words[2].start], [0.5, 0.9]);
  });

  it('estimates timings from the audio\'s pauses when the provider reports none', async () => {
    mockTts('mock-untimed-tts');
    const { supabase } = supabaseFor('mock-untimed-tts');
    const setup = await resolveTtsSetup(supabase, { script: {} });

    const result = await voiceBeat({ supabase, setup, jobId: 'job-v2', unitIndex: 3, narration: 'Prices collapsed overnight. Nobody was ready.', outputDir: tmp });
    const timings = await loadWordTimings(result.outputPath!);

    assert.equal(timings?.source, 'estimated');
    assert.equal(timings?.words.length, 6);
    const pauseStart = timings!.words[2].end;
    const nextStart = timings!.words[3].start;
    assert.ok(Math.abs(pauseStart - 1.3) < 0.15, `sentence ends near the real pause (${pauseStart})`);
    assert.ok(Math.abs(nextStart - 1.7) < 0.15, `next sentence starts after it (${nextStart})`);
  });

  it('runs voicing with bounded concurrency and keeps beat order', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10 * (8 - n)));
      inFlight--;
      return n * 10;
    });
    assert.deepEqual(results, [10, 20, 30, 40, 50, 60, 70]);
    assert.equal(peak, 3);
  });

  it('re-voices one beat with the job narrator and keeps the scripts in step', async () => {
    const { requests } = mockTts('mock-regen-tts');
    const { supabase, db } = supabaseFor('mock-regen-tts', {
      videos: [
        {
          id: 'vid-regen',
          script_json: {
            beats: [
              { index: 0, text: 'Old first line.', shots: [{ visual_type: 'stock' }] },
              { index: 1, text: 'Second line.' },
            ],
          },
        },
      ],
      yt_jobs: [
        {
          id: 'job-regen',
          video_id: 'vid-regen',
          template: 'tech',
          created_at: '2026-10-13T00:00:00Z',
          script: { voice_id: 'chosen_narrator', scenes: [{ scene_number: 0, narration: 'Old first line.' }, { scene_number: 1, narration: 'Second line.' }] },
        },
      ],
    });

    const res = await handleRegenTts(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ text: 'New first line, Dr. Smith said.' }) }),
      'vid-regen',
      '0',
      supabase,
    );
    const json = await res.json();

    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(requests[0].text, 'New first line, Doctor Smith said.');
    assert.equal(requests[0].voiceId, 'chosen_narrator');
    assert.equal(db.videos[0].script_json.beats[0].text, 'New first line, Dr. Smith said.');
    assert.equal(db.videos[0].script_json.beats[0].shots, undefined, 'stale shot plan cleared');
    assert.equal(db.yt_jobs[0].script.scenes[0].narration, 'New first line, Dr. Smith said.');
    assert.equal(db.yt_job_units.find((u) => u.unit_index === 0)?.status, 'done');
    await fs.rm(path.join(process.cwd(), 'storage', 'jobs', 'job-regen'), { recursive: true, force: true });
  });

  it('re-queuing a failed job voices beats edited after the failure', async () => {
    const { supabase, db } = createMockSupabase({
      videos: [{ id: 'vid-requeue', status: 'failed', script_json: { beats: [{ index: 0, text: 'Edited after failure.', visual_type: 'stock', visual_query: 'q', duration_estimate_seconds: 2 }] } }],
      yt_jobs: [
        {
          id: 'job-requeue',
          video_id: 'vid-requeue',
          status: 'failed',
          stages: ['tts', 'visuals'],
          created_at: '2026-10-13T00:00:00Z',
          script: { voice_id: 'v', scenes: [{ scene_number: 0, narration: 'Original text.' }] },
        },
      ],
      yt_job_stages: [{ job_id: 'job-requeue', stage: 'tts', status: 'done' }],
    });

    const res = await handleVoiceRequest(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ stages: ['tts', 'visuals'] }) }),
      'vid-requeue',
      supabase,
    );
    assert.equal(res.status, 200);
    assert.equal(db.yt_jobs[0].script.scenes[0].narration, 'Edited after failure.');
    assert.equal(db.yt_jobs[0].script.voice_id, 'v', 'narrator choice kept');
    assert.equal(db.yt_job_stages[0].status, 'pending', 'done stage reset so it re-checks its units');
  });
});
