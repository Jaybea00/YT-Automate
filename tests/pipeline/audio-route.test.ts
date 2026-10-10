import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleAudioRequest } from '../../src/app/api/jobs/[jobId]/units/[unitIndex]/audio/route.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

describe('GET /api/jobs/[jobId]/units/[unitIndex]/audio', () => {
  it('returns 404 if unit does not exist', async () => {
    const { supabase } = createMockSupabase({
      yt_job_units: [],
    });

    const req = new Request('http://localhost:3000/api/jobs/job-1/units/1/audio');
    const res = await handleAudioRequest(req, 'job-1', '1', supabase);
    assert.equal(res.status, 404);
  });

  it('returns 404 if unit stage is not tts', async () => {
    const { supabase } = createMockSupabase({
      yt_job_units: [
        {
          job_id: 'job-1',
          stage: 'image',
          unit_index: 1,
          status: 'done',
          output_path: '/fake/path.png',
        },
      ],
    });

    const req = new Request('http://localhost:3000/api/jobs/job-1/units/1/audio');
    const res = await handleAudioRequest(req, 'job-1', '1', supabase);
    assert.equal(res.status, 404);
  });

  it('returns 404 if unit status is not done (pending/running/failed)', async () => {
    const statuses = ['pending', 'running', 'failed'];

    for (const status of statuses) {
      const { supabase } = createMockSupabase({
        yt_job_units: [
          {
            job_id: 'job-1',
            stage: 'tts',
            unit_index: 1,
            status,
            output_path: '/fake/path.mp3',
          },
        ],
      });

      const req = new Request('http://localhost:3000/api/jobs/job-1/units/1/audio');
      const res = await handleAudioRequest(req, 'job-1', '1', supabase);
      assert.equal(res.status, 404, `Expected 404 for status ${status}`);
    }
  });

  it('returns 404 if output_path file does not exist on disk', async () => {
    const { supabase } = createMockSupabase({
      yt_job_units: [
        {
          job_id: 'job-1',
          stage: 'tts',
          unit_index: 1,
          status: 'done',
          output_path: '/non/existent/file.mp3',
        },
      ],
    });

    const req = new Request('http://localhost:3000/api/jobs/job-1/units/1/audio');
    const res = await handleAudioRequest(req, 'job-1', '1', supabase);
    assert.equal(res.status, 404);
  });

  it('serves full audio file with 200 OK and audio/mpeg Content-Type', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-test-'));
    const testAudioPath = path.join(tempDir, 'test.mp3');
    const sampleBytes = Buffer.from('FAKE-AUDIO-DATA-1234567890');
    await fs.writeFile(testAudioPath, sampleBytes);

    try {
      const { supabase } = createMockSupabase({
        yt_job_units: [
          {
            job_id: 'job-1',
            stage: 'tts',
            unit_index: 1,
            status: 'done',
            output_path: testAudioPath,
          },
        ],
      });

      const req = new Request('http://localhost:3000/api/jobs/job-1/units/1/audio');
      const res = await handleAudioRequest(req, 'job-1', '1', supabase);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Content-Type'), 'audio/mpeg');
      assert.equal(res.headers.get('Content-Length'), sampleBytes.length.toString());
      assert.equal(res.headers.get('Accept-Ranges'), 'bytes');

      const arrayBuf = await res.arrayBuffer();
      assert.deepEqual(Buffer.from(arrayBuf), sampleBytes);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('supports HTTP 206 Partial Content for Range requests', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-test-'));
    const testAudioPath = path.join(tempDir, 'test.mp3');
    const sampleBytes = Buffer.from('0123456789ABCDEF');
    await fs.writeFile(testAudioPath, sampleBytes);

    try {
      const { supabase } = createMockSupabase({
        yt_job_units: [
          {
            job_id: 'job-1',
            stage: 'tts',
            unit_index: 1,
            status: 'done',
            output_path: testAudioPath,
          },
        ],
      });

      // Request bytes 4-9
      const req = new Request('http://localhost:3000/api/jobs/job-1/units/1/audio', {
        headers: {
          Range: 'bytes=4-9',
        },
      });
      const res = await handleAudioRequest(req, 'job-1', '1', supabase);

      assert.equal(res.status, 206);
      assert.equal(res.headers.get('Content-Type'), 'audio/mpeg');
      assert.equal(res.headers.get('Content-Range'), `bytes 4-9/${sampleBytes.length}`);
      assert.equal(res.headers.get('Content-Length'), '6');

      const arrayBuf = await res.arrayBuffer();
      assert.deepEqual(Buffer.from(arrayBuf), sampleBytes.subarray(4, 10));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects wav format MIME type properly', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-test-'));
    const testAudioPath = path.join(tempDir, 'test.wav');
    const sampleBytes = Buffer.from('RIFF....WAVE');
    await fs.writeFile(testAudioPath, sampleBytes);

    try {
      const { supabase } = createMockSupabase({
        yt_job_units: [
          {
            job_id: 'job-1',
            stage: 'tts',
            unit_index: 2,
            status: 'done',
            output_path: testAudioPath,
          },
        ],
      });

      const req = new Request('http://localhost:3000/api/jobs/job-1/units/2/audio');
      const res = await handleAudioRequest(req, 'job-1', '2', supabase);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Content-Type'), 'audio/wav');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('avoids path traversal and only trusts the DB-stored output_path', async () => {
    const { supabase } = createMockSupabase({
      yt_job_units: [],
    });

    // An attacker tries sending ../../etc/passwd or similar as unitIndex
    const req = new Request('http://localhost:3000/api/jobs/job-1/units/../../audio');
    const res = await handleAudioRequest(req, 'job-1', '../../', supabase);

    // Fails validation on unitIndex and never accesses file system
    assert.equal(res.status, 404);
  });
});
