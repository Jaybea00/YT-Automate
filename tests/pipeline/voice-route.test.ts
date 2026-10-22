import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleVoiceRequest } from '../../src/app/api/videos/[id]/voice/route.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';
import { runJobUnit } from '../../src/pipeline/runner/unit-runner.ts';
import { computeInputHash } from '../../src/pipeline/utils/hash.ts';
import { beatsToScenes } from '../../src/pipeline/utils/mapper.ts';

describe('POST /api/videos/[id]/voice (Idempotent Route & Retry Semantics)', () => {
  const sampleVideoId = 'vid-123-abc';
  const approvedScriptJson = {
    title_options: ['Mastering Node.js Streams'],
    beats: [
      {
        index: 1,
        text: 'Node.js streams offer high performance IO processing.',
        visual_type: 'screen_recording',
        visual_query: 'code editor showing stream pipeline',
        duration_estimate_seconds: 5,
      },
      {
        index: 2,
        text: 'Notice memory consumption remains flat.',
        visual_type: 'chart',
        visual_query: 'memory graph benchmark',
        duration_estimate_seconds: 7,
      },
    ],
  };

  it('returns 404 if video does not exist', async () => {
    const { supabase } = createMockSupabase({
      videos: [],
    });

    const req = new Request('http://localhost:3000/api/videos/non-existent/voice', {
      method: 'POST',
    });

    const res = await handleVoiceRequest(req, 'non-existent', supabase);
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.match(json.error, /not found/i);
  });

  it('returns 400 if video has no approved script or beats', async () => {
    const { supabase } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Empty Video',
          status: 'script_review',
          script_json: null,
        },
      ],
    });

    const req = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
    });

    const res = await handleVoiceRequest(req, sampleVideoId, supabase);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /does not have an approved script with beats/i);
  });

  it('returns 400 if invalid stages are requested in POST body', async () => {
    const { supabase } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Valid Video',
          status: 'voicing',
          script_json: approvedScriptJson,
        },
      ],
    });

    const req = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stages: ['tts', 'invalid_stage_xyz'] }),
    });

    const res = await handleVoiceRequest(req, sampleVideoId, supabase);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /invalid stages/i);
  });

  it('creates a new pipeline job defaulting to stages: [tts] when stages omitted', async () => {
    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Mastering Node.js Streams',
          topic: 'Node.js Streams',
          style: 'tech-explainer',
          status: 'voicing',
          script_json: approvedScriptJson,
        },
      ],
      yt_jobs: [],
    });

    const req = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
    });

    const res = await handleVoiceRequest(req, sampleVideoId, supabase);
    assert.equal(res.status, 201);
    const json = await res.json();

    assert.ok(json.jobId);
    assert.equal(json.status, 'queued');
    assert.equal(json.resumed, false);

    // Verify job in database defaults to ['tts']
    assert.equal(db.yt_jobs.length, 1);
    const job = db.yt_jobs[0];
    assert.equal(job.video_id, sampleVideoId);
    assert.equal(job.status, 'queued');
    assert.deepEqual(job.stages, ['tts']);
    assert.equal(job.script.scenes.length, 2);
    assert.equal(job.script.scenes[0].scene_number, 1);
    assert.equal(job.script.scenes[0].narration, approvedScriptJson.beats[0].text);
    assert.ok(typeof job.script_fingerprint === 'string' && job.script_fingerprint.length === 64);
  });

  it('returns existing active job on duplicate request (idempotency)', async () => {
    const existingJobId = 'job-active-999';
    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Mastering Node.js Streams',
          status: 'voicing',
          script_json: approvedScriptJson,
        },
      ],
      yt_jobs: [
        {
          id: existingJobId,
          video_id: sampleVideoId,
          topic: 'Node.js Streams',
          template: 'tech-explainer',
          status: 'running',
          stages: ['tts'],
          created_at: new Date(Date.now() - 10000).toISOString(),
        },
      ],
    });

    const req = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
    });

    const res = await handleVoiceRequest(req, sampleVideoId, supabase);
    assert.equal(res.status, 200);
    const json = await res.json();

    // Idempotent return: no second job created, returned existing active job
    assert.equal(json.jobId, existingJobId);
    assert.equal(json.status, 'running');
    assert.equal(json.resumed, true);
    assert.equal(db.yt_jobs.length, 1);
  });

  it('creates a new job when the previous job was already done (e.g. new take)', async () => {
    const finishedJobId = 'job-done-111';
    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Mastering Node.js Streams',
          status: 'rendered',
          script_json: approvedScriptJson,
        },
      ],
      yt_jobs: [
        {
          id: finishedJobId,
          video_id: sampleVideoId,
          topic: 'Node.js Streams',
          template: 'tech-explainer',
          status: 'done',
          stages: ['tts'],
          created_at: new Date(Date.now() - 50000).toISOString(),
        },
      ],
    });

    const req = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
    });

    const res = await handleVoiceRequest(req, sampleVideoId, supabase);
    assert.equal(res.status, 201);
    const json = await res.json();

    assert.notEqual(json.jobId, finishedJobId);
    assert.equal(json.status, 'queued');
    assert.equal(json.resumed, false);
    assert.equal(db.yt_jobs.length, 2);
  });

  it('adds missing stages to a finished job with the same script, reusing its voicing', async () => {
    const finishedJobId = 'job-voiced-222';
    const { scriptFingerprint } = beatsToScenes(approvedScriptJson.beats as never);
    const finishedJob = {
      id: finishedJobId,
      video_id: sampleVideoId,
      topic: 'Node.js Streams',
      template: 'tech-explainer',
      status: 'done',
      stages: ['tts'],
      script: { scenes: [] },
      script_fingerprint: scriptFingerprint,
      created_at: new Date(Date.now() - 50000).toISOString(),
    };
    const { supabase, db } = createMockSupabase({
      videos: [{ id: sampleVideoId, title: 'Mastering Node.js Streams', status: 'rendered', script_json: approvedScriptJson }],
      yt_jobs: [finishedJob],
    });

    const res = await handleVoiceRequest(
      new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, { method: 'POST', body: JSON.stringify({ stages: ['tts', 'visuals'] }) }),
      sampleVideoId,
      supabase,
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.jobId, finishedJobId, 'the same job, so its voicing is reused');
    assert.deepEqual(json.addedStages, ['visuals']);
    assert.equal(db.yt_jobs.length, 1, 'no new job');
    assert.equal(db.yt_jobs[0].status, 'queued');
    assert.deepEqual(db.yt_jobs[0].stages, ['tts', 'visuals']);
  });

  it('fixes documentary pacing on a new job for a paced style, and none for others', async () => {
    const make = async (style: string) => {
      const { supabase, db } = createMockSupabase({
        videos: [{ id: sampleVideoId, title: 'Doc', style, status: 'script_review', script_json: approvedScriptJson }],
        yt_jobs: [],
      });
      const res = await handleVoiceRequest(
        new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, { method: 'POST', body: JSON.stringify({ stages: ['tts', 'visuals'] }) }),
        sampleVideoId,
        supabase,
      );
      assert.equal(res.status, 201);
      return db.yt_jobs[0].script as Record<string, unknown>;
    };
    assert.deepEqual((await make('sport')).narration_pacing, { speed: 0.9, sentencePauseSec: 0.35, beatPauseSec: 1 });
    assert.equal((await make('vox_explainer')).narration_pacing, undefined);
  });

  it('still creates a new job when the script changed since the finished job', async () => {
    const { supabase, db } = createMockSupabase({
      videos: [{ id: sampleVideoId, title: 'Mastering Node.js Streams', status: 'rendered', script_json: approvedScriptJson }],
      yt_jobs: [
        {
          id: 'job-old-333',
          video_id: sampleVideoId,
          topic: 'Node.js Streams',
          template: 'tech-explainer',
          status: 'done',
          stages: ['tts'],
          script: { scenes: [] },
          script_fingerprint: 'an-older-script',
          created_at: new Date(Date.now() - 50000).toISOString(),
        },
      ],
    });
    const res = await handleVoiceRequest(
      new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, { method: 'POST', body: JSON.stringify({ stages: ['tts', 'visuals'] }) }),
      sampleVideoId,
      supabase,
    );
    assert.equal(res.status, 201);
    assert.equal(db.yt_jobs.length, 2);
  });

  it('retry semantics: fail at unit 7, call route again, re-queues same job id and zero provider calls for units 1-6', async () => {
    const failedJobId = 'job-failed-unit-7';

    // 7 beats script
    const sevenBeats = Array.from({ length: 7 }, (_, i) => ({
      index: i + 1,
      text: `Narration sentence for beat number ${i + 1}`,
      visual_type: 'stock' as const,
      visual_query: `visual for beat ${i + 1}`,
      duration_estimate_seconds: 4,
    }));

    // Pre-populate units 1..6 as done, unit 7 as failed
    const providerId = 'elevenlabs';
    const model = 'eleven_multilingual_v2';
    const options = { voiceId: 'rachel_123' };

    const initialUnits = [];
    for (let i = 1; i <= 6; i++) {
      const input = { text: sevenBeats[i - 1].text, voiceId: options.voiceId };
      const inputHash = computeInputHash({
        stage: 'tts',
        input,
        providerId,
        model,
        options,
      });

      initialUnits.push({
        id: `unit-${i}`,
        job_id: failedJobId,
        stage: 'tts',
        unit_index: i,
        status: 'done',
        input_hash: inputHash,
        output_path: `C:/mock/storage/${failedJobId}/tts_${i}.mp3`,
        duration_ms: 4000,
        cost_usd: 0.005,
        attempts: 1,
      });
    }

    // Unit 7 failed
    initialUnits.push({
      id: 'unit-7',
      job_id: failedJobId,
      stage: 'tts',
      unit_index: 7,
      status: 'failed',
      input_hash: 'initial-hash-7',
      output_path: null,
      duration_ms: null,
      cost_usd: null,
      attempts: 1,
      error: 'Rate limit or connection drop during unit 7',
    });

    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Long 7-beat Video',
          status: 'failed',
          error_message: 'Job failed at stage: tts, unit 7',
          script_json: {
            title_options: ['Seven Beat Video'],
            beats: sevenBeats,
          },
        },
      ],
      yt_jobs: [
        {
          id: failedJobId,
          video_id: sampleVideoId,
          topic: '7 Beats',
          template: 'tech-explainer',
          status: 'failed',
          error: 'Unit 7 failed',
          stages: ['tts'],
          created_at: new Date(Date.now() - 30000).toISOString(),
        },
      ],
      yt_job_units: initialUnits,
    });

    // 1. Call POST /api/videos/[id]/voice again (video status is 'failed')
    const req = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stages: ['tts'] }),
    });

    const res = await handleVoiceRequest(req, sampleVideoId, supabase);
    assert.equal(res.status, 200);
    const json = await res.json();

    // Verify it re-queues the SAME job
    assert.equal(json.jobId, failedJobId);
    assert.equal(json.status, 'queued');
    assert.equal(json.resumed, true);
    assert.equal(db.yt_jobs.length, 1);
    assert.equal(db.yt_jobs[0].status, 'queued');
    assert.equal(db.yt_jobs[0].error, null);
    assert.equal(db.videos[0].status, 'voicing');
    assert.equal(db.videos[0].error_message, null);

    // 2. Track provider execution calls on re-run
    const providerCalls: number[] = [];

    // Simulate worker processing units 1 through 7 for this re-queued job
    for (const beat of sevenBeats) {
      const input = { text: beat.text, voiceId: options.voiceId };

      const result = await runJobUnit({
        jobId: failedJobId,
        stage: 'tts',
        unitIndex: beat.index,
        input,
        providerId,
        model,
        options,
        supabase,
        outputDir: `C:/mock/storage/${failedJobId}`,
        checkFileExists: async () => true, // finished files exist on disk
        measureDuration: async () => 4000,
        execute: async () => {
          providerCalls.push(beat.index);
          return {
            bytes: new Uint8Array([1, 2, 3]),
            durationMs: 4000,
            usage: { characters: beat.text.length, costUsd: 0.005 },
          };
        },
      });

      if (beat.index <= 6) {
        assert.equal(result.skipped, true, `Unit ${beat.index} should have been skipped`);
      } else {
        assert.equal(result.skipped, false, 'Unit 7 should have executed');
      }
    }

    // Zero provider calls for units 1..6; only unit 7 was called
    assert.deepEqual(providerCalls, [7]);
    assert.equal(providerCalls.filter((idx) => idx <= 6).length, 0);
  });

  it('returns 400 if invalid ttsProvider is requested', async () => {
    const { supabase } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Valid Video',
          status: 'voicing',
          script_json: approvedScriptJson,
        },
      ],
    });

    const req = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttsProvider: 'azure' }),
    });

    const res = await handleVoiceRequest(req, sampleVideoId, supabase);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /invalid ttsProvider/i);
  });

  it('returns 400 if ttsProviderConfigId does not exist or is inactive', async () => {
    const { supabase } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Valid Video',
          status: 'voicing',
          script_json: approvedScriptJson,
        },
      ],
      yt_provider_configs: [
        {
          id: 'inactive-tts-cfg',
          kind: 'tts',
          provider: 'openai-compatible',
          label: 'Inactive Kokoro',
          is_active: false,
        },
      ],
    });

    // 1. Non-existent ID
    const req1 = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttsProviderConfigId: 'non-existent-id' }),
    });
    const res1 = await handleVoiceRequest(req1, sampleVideoId, supabase);
    assert.equal(res1.status, 400);
    const json1 = await res1.json();
    assert.match(json1.error, /not found/i);

    // 2. Inactive config
    const req2 = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttsProviderConfigId: 'inactive-tts-cfg' }),
    });
    const res2 = await handleVoiceRequest(req2, sampleVideoId, supabase);
    assert.equal(res2.status, 400);
    const json2 = await res2.json();
    assert.match(json2.error, /inactive/i);
  });

  it('creates job with tts_provider_config_id when ttsProvider: "kokoro" is requested', async () => {
    const kokoroConfigId = 'kokoro-active-uuid';
    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Mastering Node.js Streams',
          topic: 'Node.js Streams',
          style: 'tech-explainer',
          status: 'voicing',
          script_json: approvedScriptJson,
        },
      ],
      yt_provider_configs: [
        {
          id: 'elevenlabs-active-uuid',
          kind: 'tts',
          provider: 'elevenlabs',
          label: 'ElevenLabs Main',
          is_active: true,
          created_at: new Date(Date.now() - 20000).toISOString(),
        },
        {
          id: kokoroConfigId,
          kind: 'tts',
          provider: 'openai-compatible',
          label: 'Kokoro Local',
          base_url: 'http://localhost:8880/v1',
          default_model: 'kokoro',
          is_active: true,
          created_at: new Date(Date.now() - 10000).toISOString(),
        },
      ],
      yt_jobs: [],
    });

    const req = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttsProvider: 'kokoro' }),
    });

    const res = await handleVoiceRequest(req, sampleVideoId, supabase);
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.ttsProviderConfigId, kokoroConfigId);

    assert.equal(db.yt_jobs.length, 1);
    const createdJob = db.yt_jobs[0];
    assert.equal(createdJob.script.tts_provider_config_id, kokoroConfigId);
  });

  it('creates job with tts_provider_config_id when ttsProviderConfigId is explicitly passed', async () => {
    const customConfigId = 'custom-tts-uuid-999';
    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Mastering Node.js Streams',
          status: 'voicing',
          script_json: approvedScriptJson,
        },
      ],
      yt_provider_configs: [
        {
          id: customConfigId,
          kind: 'tts',
          provider: 'openai-compatible',
          label: 'Custom Kokoro',
          is_active: true,
        },
      ],
      yt_jobs: [],
    });

    const req = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttsProviderConfigId: customConfigId }),
    });

    const res = await handleVoiceRequest(req, sampleVideoId, supabase);
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.ttsProviderConfigId, customConfigId);

    assert.equal(db.yt_jobs.length, 1);
    assert.equal(db.yt_jobs[0].script.tts_provider_config_id, customConfigId);
  });

  it('re-queues failed job updating tts_provider_config_id when override is provided', async () => {
    const failedJobId = 'job-requeue-override';
    const kokoroConfigId = 'kokoro-override-uuid';

    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Failed Video',
          status: 'failed',
          error_message: 'ElevenLabs quota exceeded',
          script_json: approvedScriptJson,
        },
      ],
      yt_provider_configs: [
        {
          id: kokoroConfigId,
          kind: 'tts',
          provider: 'openai-compatible',
          label: 'Kokoro Local',
          is_active: true,
        },
      ],
      yt_jobs: [
        {
          id: failedJobId,
          video_id: sampleVideoId,
          topic: 'Streams',
          template: 'tech-explainer',
          status: 'failed',
          stages: ['tts'],
          script: {
            title: 'Failed Video',
            scenes: [{ scene_number: 1, narration: 'test' }],
          },
          created_at: new Date(Date.now() - 10000).toISOString(),
        },
      ],
    });

    const req = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttsProvider: 'kokoro' }),
    });

    const res = await handleVoiceRequest(req, sampleVideoId, supabase);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.jobId, failedJobId);
    assert.equal(json.status, 'queued');
    assert.equal(json.ttsProviderConfigId, kokoroConfigId);

    assert.equal(db.yt_jobs[0].script.tts_provider_config_id, kokoroConfigId);
  });

  it('creates job with narratorId, voice_id, voice_override and updates video.narrator_id', async () => {
    const kokoroConfigId = 'config-kokoro-uuid';
    const narratorId = 'narrator-bella-uuid';
    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: sampleVideoId,
          title: 'Streams Explained',
          status: 'script_review',
          script_json: approvedScriptJson,
        },
      ],
      yt_provider_configs: [
        {
          id: kokoroConfigId,
          kind: 'tts',
          provider: 'openai-compatible',
          label: 'Kokoro Local',
          is_active: true,
        },
      ],
      narrators: [
        {
          id: narratorId,
          provider_config_id: kokoroConfigId,
          voice_id: 'af_bella',
          name: 'Bella',
          tier: 'high',
        },
      ],
      yt_jobs: [],
    });

    const req = new Request(`http://localhost:3000/api/videos/${sampleVideoId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ narratorId }),
    });

    const res = await handleVoiceRequest(req, sampleVideoId, supabase);
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.narratorId, narratorId);
    assert.equal(json.voiceId, 'af_bella');
    assert.equal(json.ttsProviderConfigId, kokoroConfigId);

    assert.equal(db.yt_jobs[0].script.tts_provider_config_id, kokoroConfigId);
    assert.equal(db.yt_jobs[0].script.voice_id, 'af_bella');
    assert.equal(db.yt_jobs[0].script.voice_override, 'af_bella');
    assert.equal(db.yt_jobs[0].script.narrator_id, narratorId);
    assert.equal(db.videos[0].narrator_id, narratorId);
  });
});

