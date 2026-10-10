import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSrtTime,
  formatVttTime,
  splitTextIntoChunks,
  generateSubtitles,
} from '../../src/pipeline/utils/subtitles';
import { handleGetSubtitles } from '../../src/app/api/videos/[id]/subtitles/route';

test('Subtitles Pipeline & Formatting Tests', async (t) => {
  await t.test('1. formatSrtTime formats with comma and formatVttTime formats with dot', () => {
    assert.equal(formatSrtTime(0), '00:00:00,000');
    assert.equal(formatSrtTime(1500), '00:00:01,500');
    assert.equal(formatSrtTime(65123), '00:01:05,123');
    assert.equal(formatSrtTime(3661005), '01:01:01,005');

    assert.equal(formatVttTime(0), '00:00:00.000');
    assert.equal(formatVttTime(1500), '00:00:01.500');
    assert.equal(formatVttTime(65123), '00:01:05.123');
    assert.equal(formatVttTime(3661005), '01:01:01.005');
  });

  await t.test('2. splitTextIntoChunks splits natural sentences within max characters', () => {
    const single = splitTextIntoChunks('Short sentence.', 80);
    assert.equal(single.length, 1);
    assert.equal(single[0], 'Short sentence.');

    const longText =
      'First sentence here is crisp. Second sentence elaborates on the concept nicely. Third sentence wraps up the point.';
    const chunks = splitTextIntoChunks(longText, 60);
    assert.ok(chunks.length >= 2, 'Must split into multiple chunks');
    for (const c of chunks) {
      assert.ok(c.length <= 80, `Chunk length (${c.length}) should remain reasonable`);
    }
  });

  await t.test('3. generateSubtitles creates accurate SRT and WebVTT from measured TTS units', () => {
    const beats = [
      { index: 0, text: 'Welcome to this comprehensive tutorial.' },
      { index: 1, text: 'First we will configure our environment.' },
    ];

    const units = [
      { unit_index: 0, duration_ms: 3200 },
      { unit_index: 1, duration_ms: 4800 },
    ];

    const result = generateSubtitles({ beats, units });

    assert.equal(result.hasMeasuredDurations, true);
    assert.equal(result.totalDurationMs, 8000);
    assert.equal(result.cues.length, 2);

    // Cue 1: 0ms to 3200ms
    assert.equal(result.cues[0].startMs, 0);
    assert.equal(result.cues[0].endMs, 3200);
    assert.equal(result.cues[0].text, 'Welcome to this comprehensive tutorial.');

    // Cue 2: 3200ms to 8000ms
    assert.equal(result.cues[1].startMs, 3200);
    assert.equal(result.cues[1].endMs, 8000);
    assert.equal(result.cues[1].text, 'First we will configure our environment.');

    // SRT output check
    assert.match(result.srt, /1\n00:00:00,000 --> 00:00:03,200\nWelcome to this comprehensive tutorial\./);
    assert.match(result.srt, /2\n00:00:03,200 --> 00:00:08,000\nFirst we will configure our environment\./);

    // VTT output check
    assert.match(result.vtt, /^WEBVTT/);
    assert.match(result.vtt, /00:00:00\.000 --> 00:00:03\.200/);
    assert.match(result.vtt, /00:00:03\.200 --> 00:00:08\.000/);
  });

  await t.test('4. handleGetSubtitles route serves SRT and VTT with proper MIME types', async () => {
    const mockVideo = {
      id: 'vid-sub-1',
      title: 'Guide to Rust',
      status: 'rendered',
      script_json: {
        beats: [
          { index: 0, text: 'Hello Rustaceans.' },
          { index: 1, text: 'Memory safety without garbage collection.' },
        ],
      },
    };

    const mockUnits = [
      { job_id: 'job-sub-1', stage: 'tts', unit_index: 0, duration_ms: 2000, status: 'done' },
      { job_id: 'job-sub-1', stage: 'tts', unit_index: 1, duration_ms: 3500, status: 'done' },
    ];

    const mockSupabase: any = {
      from(table: string) {
        if (table === 'videos') {
          return {
            select() {
              return {
                eq() {
                  return {
                    async maybeSingle() {
                      return { data: mockVideo, error: null };
                    },
                  };
                },
              };
            },
          };
        }
        if (table === 'yt_jobs') {
          return {
            select() {
              return {
                eq() {
                  return {
                    order() {
                      return {
                        limit() {
                          return {
                            async maybeSingle() {
                              return { data: { id: 'job-sub-1' }, error: null };
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
        if (table === 'yt_job_units') {
          return {
            select() {
              return {
                eq() {
                  return {
                    in() {
                      return Promise.resolve({ data: mockUnits, error: null });
                    },
                  };
                },
              };
            },
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    };

    // Test SRT
    const reqSrt = new Request('http://localhost/api/videos/vid-sub-1/subtitles?format=srt&download=1');
    const resSrt = await handleGetSubtitles(reqSrt, 'vid-sub-1', mockSupabase);
    assert.equal(resSrt.status, 200);
    assert.match(resSrt.headers.get('content-type') || '', /text\/plain/);
    assert.match(resSrt.headers.get('content-disposition') || '', /attachment; filename="Guide_to_Rust.srt"/);
    const bodySrt = await resSrt.text();
    assert.match(bodySrt, /00:00:00,000 --> 00:00:02,000/);

    // Test VTT
    const reqVtt = new Request('http://localhost/api/videos/vid-sub-1/subtitles?format=vtt');
    const resVtt = await handleGetSubtitles(reqVtt, 'vid-sub-1', mockSupabase);
    assert.equal(resVtt.status, 200);
    assert.match(resVtt.headers.get('content-type') || '', /text\/vtt/);
    const bodyVtt = await resVtt.text();
    assert.match(bodyVtt, /WEBVTT/);
    assert.match(bodyVtt, /00:00:00\.000 --> 00:00:02\.000/);
  });
});
