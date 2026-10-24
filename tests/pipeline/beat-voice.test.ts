import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeBeatVoice, readBeatVoices, resolveTtsSetup, setupForBeat, voiceBeat } from '../../src/pipeline/tts/voice-beat.ts';
import { prepareRecording, saveBeatVoice } from '../../src/pipeline/tts/beat-voice-store.ts';
import { loadWordTimings } from '../../src/pipeline/tts/word-timings.ts';
import { rendersDir } from '../../src/pipeline/publish/publish-assets.ts';
import { getAudioDurationMs } from '../../src/pipeline/utils/ffmpeg.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { TTSProvider, TtsRequest } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);

describe('Per-beat voice controls', () => {
  let tmp: string;
  let tone: Uint8Array;
  const videoId = `test-beatvoice-${Date.now()}`;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'beat-voice-'));
    const file = path.join(tmp, 'tone.mp3');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:r=24000:d=1.5', '-c:a', 'libmp3lame', file]);
    tone = new Uint8Array(await fs.readFile(file));
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(rendersDir(videoId), { recursive: true, force: true });
  });

  function tts(id: string) {
    const requests: TtsRequest[] = [];
    const provider: TTSProvider = {
      kind: 'tts',
      id,
      synthesize: async (req) => {
        requests.push(req);
        return { bytes: tone, mimeType: 'audio/mpeg', usage: {} };
      },
    };
    registerProvider('tts', id, provider);
    return requests;
  }

  it('cleans settings', () => {
    assert.deepEqual(normalizeBeatVoice({ speed: 3, narratorId: 'n-1' }), { speed: 1.5, narratorId: 'n-1' });
    assert.equal(normalizeBeatVoice({ speed: 1, narratorId: 'bad id!' }), null);
    assert.deepEqual(readBeatVoices({ 0: { speed: 0.8 }, 1: {}, y: { speed: 0.9 } }), { 0: { speed: 0.8 } });
  });

  it('voices a beat at its own pace with another narrator', async () => {
    const main = tts('mock-main-tts');
    const quote = tts('mock-quote-tts');
    const { supabase } = createMockSupabase({
      yt_provider_configs: [
        { id: 'cfg-main', kind: 'tts', provider: 'mock-main-tts', label: 'main', is_active: true, options: { voice: 'main_voice' } },
        { id: 'cfg-quote', kind: 'tts', provider: 'mock-quote-tts', label: 'quote', is_active: true, options: {} },
      ],
      yt_stage_bindings: [{ stage: 'tts', provider_config_id: 'cfg-main', max_retries: 0 }],
      narrators: [{ id: 'nar-quote', provider_config_id: 'cfg-quote', voice_id: 'old_man', name: 'Old man' }],
    });
    const base = await resolveTtsSetup(supabase, { template: 'history', script: { narration_pacing: { speed: 0.9, sentencePauseSec: 0 } } });
    const slower = await setupForBeat(supabase, base, { speed: 0.8 });
    assert.equal(slower.pacing?.speed, 0.72, "a multiple of the job's pace");

    const result = await voiceBeat({ supabase, setup: base, jobId: 'job-bv', unitIndex: 3, narration: 'I was there.', outputDir: tmp, beatVoice: { narratorId: 'nar-quote' } });
    assert.equal(result.success, true);
    assert.equal(main.length, 0);
    assert.deepEqual([quote[0].voiceId, quote[0].speed], ['old_man', 0.9]);
  });

  it("uses the creator's recording instead of a voice, and keeps it on later voicing runs", async () => {
    const requests = tts('mock-rec-tts');
    const { supabase } = createMockSupabase({
      yt_provider_configs: [{ id: 'cfg-rec', kind: 'tts', provider: 'mock-rec-tts', label: 'rec', is_active: true, options: {} }],
      yt_stage_bindings: [{ stage: 'tts', provider_config_id: 'cfg-rec', max_retries: 0 }],
    });
    const setup = await resolveTtsSetup(supabase, { template: 'history', script: {} });
    const take = path.join(tmp, 'take.mp3');
    await fs.writeFile(take, tone);
    const recorded = { path: take, durationMs: 1500 };

    const first = await voiceBeat({ supabase, setup, jobId: 'job-rec', unitIndex: 0, narration: 'My own words.', outputDir: tmp, beatVoice: { recorded } });
    assert.equal(first.success, true);
    assert.equal(requests.length, 0, 'no voice was synthesized');
    assert.deepEqual(await fs.readFile(first.outputPath!), Buffer.from(tone));
    assert.equal((await loadWordTimings(first.outputPath!))?.source, 'estimated');

    const again = await voiceBeat({ supabase, setup, jobId: 'job-rec', unitIndex: 0, narration: 'My own words.', outputDir: tmp, beatVoice: { recorded } });
    assert.equal(again.skipped, true, 'a voicing run keeps the recording');
    assert.equal(requests.length, 0);
  });

  it('cleans up a microphone take: trims the silence, refuses an empty one', async () => {
    const raw = path.join(tmp, 'mic.webm');
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=2',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1.2', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-c:a', 'libopus', raw,
    ]);
    const prepared = await prepareRecording(raw, videoId, 2);
    assert.ok(prepared.path.startsWith(rendersDir(videoId)));
    assert.ok(Math.abs(prepared.durationMs - 2000) < 400, `the silence either side is trimmed (${prepared.durationMs} ms)`);
    assert.equal(await getAudioDurationMs(prepared.path), prepared.durationMs);

    const silent = path.join(tmp, 'silent.webm');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=2', '-c:a', 'libopus', silent]);
    await assert.rejects(prepareRecording(silent, videoId, 2), /empty or silent/);
  });

  it('saves settings field by field', async () => {
    const { supabase, db } = createMockSupabase({ videos: [{ id: 'v-bv', script_json: { beats: [{ text: 'a' }, { text: 'b' }] } }] });
    await saveBeatVoice(supabase, 'v-bv', 1, { speed: 0.85 });
    await saveBeatVoice(supabase, 'v-bv', 1, { recorded: { path: 'x.mp3', durationMs: 900 } });
    assert.deepEqual(db.videos[0].script_json.beat_voice, { 1: { speed: 0.85, recorded: { path: 'x.mp3', durationMs: 900 } } });
    await saveBeatVoice(supabase, 'v-bv', 1, { recorded: null, speed: null });
    assert.deepEqual(db.videos[0].script_json.beat_voice, {});
    await assert.rejects(saveBeatVoice(supabase, 'v-bv', 5, { speed: 0.9 }), /does not exist/);
  });
});
