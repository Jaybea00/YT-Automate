import test from 'node:test';
import assert from 'node:assert/strict';
import { handleGetChapters, handlePostChapters } from '../../src/app/api/videos/[id]/chapters/route';

interface MockVideo {
  id: string;
  title: string | null;
  topic: string | null;
  status: string;
  script_json: any;
}

interface MockJob {
  id: string;
  video_id: string;
  created_at: string;
  status: string;
}

interface MockUnit {
  job_id: string;
  stage: string;
  unit_index: number;
  duration_ms: number;
  status: string;
}

function createMockSupabase(initialVideo: MockVideo, initialUnits: MockUnit[] = []) {
  let videoRecord = { ...initialVideo };
  const units = [...initialUnits];
  const jobs: MockJob[] = [
    {
      id: 'job-mock-1',
      video_id: initialVideo.id,
      created_at: '2026-10-08T00:00:00Z',
      status: 'done',
    },
  ];

  return {
    from(tableName: string) {
      if (tableName === 'videos') {
        return {
          select(_cols: string) {
            return {
              eq(col: string, val: any) {
                return {
                  async maybeSingle() {
                    if (val === videoRecord.id) {
                      return { data: { ...videoRecord }, error: null };
                    }
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
          update(updates: any) {
            return {
              eq(col: string, val: any) {
                if (val === videoRecord.id) {
                  videoRecord = { ...videoRecord, ...updates };
                  return { data: videoRecord, error: null };
                }
                return { data: null, error: new Error('Video not found') };
              },
            };
          },
        };
      }

      if (tableName === 'yt_jobs') {
        return {
          select(_cols: string) {
            return {
              eq(col: string, val: any) {
                return {
                  order(_orderCol: string, _opts: any) {
                    return {
                      limit(_n: number) {
                        return {
                          async maybeSingle() {
                            const found = jobs.find((j) => j.video_id === val);
                            return { data: found || null, error: null };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (tableName === 'yt_job_units') {
        return {
          select(_cols: string) {
            return {
              eq(col: string, val: any) {
                return {
                  in(col2: string, stages: string[]) {
                    const matching = units.filter(
                      (u) => u.job_id === val && stages.includes(u.stage),
                    );
                    return Promise.resolve({ data: matching, error: null });
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table ${tableName}`);
    },
    getVideoRecord() {
      return videoRecord;
    },
  } as any;
}

test('Chapters API Route (/api/videos/[id]/chapters)', async (t) => {
  await t.test('1. returns 404 for nonexistent video', async () => {
    const supabase = createMockSupabase({
      id: 'video-123',
      title: 'Test',
      topic: 'React',
      status: 'rendered',
      script_json: {},
    });

    const req = new Request('http://localhost/api/videos/nonexistent/chapters');
    const res = await handleGetChapters(req, 'nonexistent', supabase);
    assert.equal(res.status, 404);
  });

  await t.test('2. generates accurate cumulative chapters from measured TTS units', async () => {
    const mockVideo: MockVideo = {
      id: 'vid-456',
      title: 'Full Guide to TypeScript',
      topic: 'TypeScript',
      status: 'rendered',
      script_json: {
        beats: [
          { index: 0, text: 'Hook: Learn TypeScript without the headache.', duration_estimate_seconds: 5 },
          { index: 1, text: 'Step 1: Setting up strict type checking.', duration_estimate_seconds: 10 },
          { index: 2, text: 'Step 2: Advanced generics patterns.', duration_estimate_seconds: 15 },
        ],
      },
    };

    const mockUnits: MockUnit[] = [
      { job_id: 'job-mock-1', stage: 'tts', unit_index: 0, duration_ms: 3500, status: 'done' },
      { job_id: 'job-mock-1', stage: 'tts', unit_index: 1, duration_ms: 7800, status: 'done' },
      { job_id: 'job-mock-1', stage: 'tts', unit_index: 2, duration_ms: 12000, status: 'done' },
    ];

    const supabase = createMockSupabase(mockVideo, mockUnits);
    const req = new Request('http://localhost/api/videos/vid-456/chapters');
    const res = await handleGetChapters(req, 'vid-456', supabase);

    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.videoId, 'vid-456');
    assert.equal(body.hasMeasuredDurations, true);
    assert.equal(body.chapters.length, 3);

    // Timestamps:
    // Beat 0: 00:00 (duration: 3500ms)
    // Beat 1: 00:03 (duration: 7800ms)
    // Beat 2: 00:11 (3.5 + 7.8 = 11.3s -> 00:11)
    assert.equal(body.chapters[0].timestamp, '00:00');
    assert.equal(body.chapters[0].title, 'Learn TypeScript without the headache');
    assert.equal(body.chapters[1].timestamp, '00:03');
    assert.equal(body.chapters[1].title, 'Setting up strict type checking');
    assert.equal(body.chapters[2].timestamp, '00:11');
    assert.equal(body.chapters[2].title, 'Advanced generics patterns');

    assert.match(body.formattedText, /00:00 - Learn TypeScript without the headache/);
    assert.match(body.formattedText, /00:03 - Setting up strict type checking/);
    assert.match(body.formattedText, /00:11 - Advanced generics patterns/);
  });

  await t.test('3. allows updating and saving custom chapter titles via POST', async () => {
    const mockVideo: MockVideo = {
      id: 'vid-789',
      title: 'NextJS Optimization',
      topic: 'NextJS',
      status: 'rendered',
      script_json: {
        beats: [
          { index: 0, text: 'Intro', duration_estimate_seconds: 5 },
          { index: 1, text: 'Core concept', duration_estimate_seconds: 10 },
        ],
      },
    };

    const supabase = createMockSupabase(mockVideo);

    const postReq = new Request('http://localhost/api/videos/vid-789/chapters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customTitles: {
          0: 'Introduction to Performance',
          1: 'Deep Dive: Server Components',
        },
      }),
    });

    const res = await handlePostChapters(postReq, 'vid-789', supabase);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.chapters[0].title, 'Introduction to Performance');
    assert.equal(body.chapters[1].title, 'Deep Dive: Server Components');
    assert.equal(
      body.formattedText,
      '00:00 - Introduction to Performance\n00:05 - Deep Dive: Server Components',
    );

    // Verify persisted in DB
    const updated = supabase.getVideoRecord();
    assert.equal(
      updated.script_json.custom_chapters[0],
      'Introduction to Performance',
    );
  });
});
