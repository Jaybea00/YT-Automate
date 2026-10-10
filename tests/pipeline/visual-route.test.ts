import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleVisualRequest } from '../../src/app/api/jobs/[jobId]/units/[unitIndex]/visual/route.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

describe('GET /api/jobs/[jobId]/units/[unitIndex]/visual', () => {
  it('returns 404 if unit does not exist', async () => {
    const { supabase } = createMockSupabase({
      yt_job_units: [],
    });

    const req = new Request('http://localhost:3000/api/jobs/job-1/units/1/visual');
    const res = await handleVisualRequest(req, 'job-1', '1', supabase);
    assert.equal(res.status, 404);
  });

  it('returns 404 if unit stage is not visuals', async () => {
    const { supabase } = createMockSupabase({
      yt_job_units: [
        {
          job_id: 'job-1',
          stage: 'tts',
          unit_index: 1,
          status: 'done',
          output_path: '/fake/path.mp3',
        },
      ],
    });

    const req = new Request('http://localhost:3000/api/jobs/job-1/units/1/visual');
    const res = await handleVisualRequest(req, 'job-1', '1', supabase);
    assert.equal(res.status, 404);
  });

  it('returns 404 if unit status is not done (pending/running/failed)', async () => {
    const statuses = ['pending', 'running', 'failed'];

    for (const status of statuses) {
      const { supabase } = createMockSupabase({
        yt_job_units: [
          {
            job_id: 'job-1',
            stage: 'visuals',
            unit_index: 1,
            status,
            output_path: '/fake/path.mp4',
          },
        ],
      });

      const req = new Request('http://localhost:3000/api/jobs/job-1/units/1/visual');
      const res = await handleVisualRequest(req, 'job-1', '1', supabase);
      assert.equal(res.status, 404, `Expected 404 for status ${status}`);
    }
  });

  it('returns 404 if output_path file does not exist on disk', async () => {
    const { supabase } = createMockSupabase({
      yt_job_units: [
        {
          job_id: 'job-1',
          stage: 'visuals',
          unit_index: 1,
          status: 'done',
          output_path: path.join(os.tmpdir(), 'non_existent_visual_file_xyz123.mp4'),
        },
      ],
    });

    const req = new Request('http://localhost:3000/api/jobs/job-1/units/1/visual');
    const res = await handleVisualRequest(req, 'job-1', '1', supabase);
    assert.equal(res.status, 404);
  });

  it('serves full video file with 200 OK and video/mp4 Content-Type', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-route-test-'));
    const testFilePath = path.join(tempDir, 'test-beat-1.mp4');
    const testContent = Buffer.from('Fake MP4 content for testing video endpoint');
    await fs.writeFile(testFilePath, testContent);

    try {
      const { supabase } = createMockSupabase({
        yt_job_units: [
          {
            job_id: 'job-1',
            stage: 'visuals',
            unit_index: 1,
            status: 'done',
            output_path: testFilePath,
          },
        ],
      });

      const req = new Request('http://localhost:3000/api/jobs/job-1/units/1/visual');
      const res = await handleVisualRequest(req, 'job-1', '1', supabase);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Content-Type'), 'video/mp4');
      assert.equal(res.headers.get('Content-Length'), testContent.length.toString());
      assert.equal(res.headers.get('Accept-Ranges'), 'bytes');

      const arrayBuf = await res.arrayBuffer();
      const bodyBuffer = Buffer.from(arrayBuf);
      assert.equal(bodyBuffer.toString(), testContent.toString());
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('serves chart image with 200 OK and image/png Content-Type', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-route-img-'));
    const testFilePath = path.join(tempDir, 'test-chart-beat-9.png');
    const testContent = Buffer.from('Fake PNG content for testing image endpoint');
    await fs.writeFile(testFilePath, testContent);

    try {
      const { supabase } = createMockSupabase({
        yt_job_units: [
          {
            job_id: 'job-1',
            stage: 'visuals',
            unit_index: 9,
            status: 'done',
            output_path: testFilePath,
          },
        ],
      });

      const req = new Request('http://localhost:3000/api/jobs/job-1/units/9/visual');
      const res = await handleVisualRequest(req, 'job-1', '9', supabase);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Content-Type'), 'image/png');
      assert.equal(res.headers.get('Content-Length'), testContent.length.toString());

      const arrayBuf = await res.arrayBuffer();
      const bodyBuffer = Buffer.from(arrayBuf);
      assert.equal(bodyBuffer.toString(), testContent.toString());
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('supports HTTP 206 Partial Content for video scrubbing Range requests', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-route-range-'));
    const testFilePath = path.join(tempDir, 'test-range.mp4');
    const testContent = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    await fs.writeFile(testFilePath, testContent);

    try {
      const { supabase } = createMockSupabase({
        yt_job_units: [
          {
            job_id: 'job-1',
            stage: 'visuals',
            unit_index: 2,
            status: 'done',
            output_path: testFilePath,
          },
        ],
      });

      // Request bytes 5 to 14 (10 bytes total)
      const req = new Request('http://localhost:3000/api/jobs/job-1/units/2/visual', {
        headers: {
          Range: 'bytes=5-14',
        },
      });
      const res = await handleVisualRequest(req, 'job-1', '2', supabase);

      assert.equal(res.status, 206);
      assert.equal(res.headers.get('Content-Type'), 'video/mp4');
      assert.equal(res.headers.get('Content-Range'), `bytes 5-14/${testContent.length}`);
      assert.equal(res.headers.get('Content-Length'), '10');

      const arrayBuf = await res.arrayBuffer();
      const bodyBuffer = Buffer.from(arrayBuf);
      assert.equal(bodyBuffer.toString(), '56789abcde');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('avoids path traversal and only trusts the DB-stored output_path', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-traversal-'));
    const targetFilePath = path.join(tempDir, 'target.mp4');
    await fs.writeFile(targetFilePath, 'Authorized visual');

    try {
      const { supabase } = createMockSupabase({
        yt_job_units: [
          {
            job_id: 'job-1',
            stage: 'visuals',
            unit_index: 1,
            status: 'done',
            output_path: targetFilePath,
          },
        ],
      });

      // Attempting to pass unit index with path traversal should fail
      const req = new Request('http://localhost:3000/api/jobs/job-1/units/..%2F..%2Fetc/visual');
      const res = await handleVisualRequest(req, 'job-1', '../../etc', supabase);
      assert.equal(res.status, 404);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
