import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  renderBeatScene,
  concatenateSceneClips,
} from '../../src/pipeline/assembly/assemble-beat.ts';
import { checkAssemblyGate } from '../../src/pipeline/assembly/gate.ts';
import { JobRunner } from '../../src/pipeline/runner/job-runner.ts';
import {
  getFfmpegPath,
  getAudioDurationMs,
  getVideoDurationMs,
} from '../../src/pipeline/utils/ffmpeg.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';
import { handleGetRender } from '../../src/app/api/videos/[id]/render/route.ts';

const execFileAsync = promisify(execFile);

describe('Assembly Stage Pipeline Tests', () => {
  let tempDir: string;
  let testAudio1: string; // 2.0s
  let testAudio2: string; // 1.5s
  let testShortVideo: string; // 1.0s video
  let testImage: string; // static png
  const ffmpegBin = getFfmpegPath();

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-assembly-test-'));

    testAudio1 = path.join(tempDir, 'audio1.mp3');
    testAudio2 = path.join(tempDir, 'audio2.mp3');
    testShortVideo = path.join(tempDir, 'short_video.mp4');
    testImage = path.join(tempDir, 'test_image.png');

    // 1. Generate 2.0s test audio
    await execFileAsync(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '2.0',
      '-c:a',
      'libmp3lame',
      testAudio1,
    ]);

    // 2. Generate 1.5s test audio
    await execFileAsync(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000',
      '-t',
      '1.5',
      '-c:a',
      'libmp3lame',
      testAudio2,
    ]);

    // 3. Generate 1.0s video
    await execFileAsync(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=30',
      '-t',
      '1.0',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      testShortVideo,
    ]);

    // 4. Generate test still image
    await execFileAsync(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=navy:s=640x360',
      '-frames:v',
      '1',
      testImage,
    ]);
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('1. Short clip is held (last frame cloned) to match exact audio duration', async () => {
    const sceneOut = path.join(tempDir, 'scene_hold.mp4');
    // Short video is 1.0s, audio is 2.0s (2000ms)
    await renderBeatScene({
      visualPath: testShortVideo,
      audioPath: testAudio1,
      durationMs: 2000,
      outputPath: sceneOut,
      isVideo: true,
      shortVideoBehavior: 'hold',
    });

    const measuredDurationMs = await getVideoDurationMs(sceneOut);
    // Tolerance within 100ms
    assert.ok(
      Math.abs(measuredDurationMs - 2000) <= 100,
      `Expected ~2000ms, got ${measuredDurationMs}ms`,
    );
  });

  it('2. Image beat renders properly with letterboxing to 1920x1080', async () => {
    const sceneOut = path.join(tempDir, 'scene_image.mp4');
    await renderBeatScene({
      visualPath: testImage,
      audioPath: testAudio2,
      durationMs: 1500,
      outputPath: sceneOut,
      isVideo: false,
      stillMotion: 'static',
    });

    const measuredDurationMs = await getVideoDurationMs(sceneOut);
    assert.ok(
      Math.abs(measuredDurationMs - 1500) <= 100,
      `Expected ~1500ms, got ${measuredDurationMs}ms`,
    );
  });

  it('3. Total video duration matches sum of TTS durations within tolerance', async () => {
    const clip1 = path.join(tempDir, 'clip_1.mp4');
    const clip2 = path.join(tempDir, 'clip_2.mp4');
    const concatOut = path.join(tempDir, 'final_concat.mp4');

    await renderBeatScene({
      visualPath: testShortVideo,
      audioPath: testAudio1,
      durationMs: 2000,
      outputPath: clip1,
      isVideo: true,
      shortVideoBehavior: 'hold',
    });

    await renderBeatScene({
      visualPath: testImage,
      audioPath: testAudio2,
      durationMs: 1500,
      outputPath: clip2,
      isVideo: false,
      stillMotion: 'static',
    });

    await concatenateSceneClips([clip1, clip2], concatOut, tempDir);

    const totalDurationMs = await getVideoDurationMs(concatOut);
    const expectedDurationMs = 2000 + 1500; // 3500ms
    assert.ok(
      Math.abs(totalDurationMs - expectedDurationMs) <= 150,
      `Total duration ${totalDurationMs}ms should match sum ${expectedDurationMs}ms`,
    );
  });

  it('4. Assembly gate refuses to start if any beat lacks an asset', async () => {
    const { supabase } = createMockSupabase({
      videos: [
        {
          id: 'vid-gate-test',
          script_json: {
            beats: [
              { index: 0, text: 'Beat 0' },
              { index: 1, text: 'Beat 1' },
            ],
          },
        },
      ],
      video_assets: [
        // Only beat 0 has an asset
        { video_id: 'vid-gate-test', beat_index: 0, visual_type: 'uploaded' },
      ],
    });

    const result = await checkAssemblyGate(supabase, 'vid-gate-test');
    assert.equal(result.ready, false);
    assert.equal(result.status, 400);
    assert.deepEqual(result.missingBeats, [1]);
  });

  it('5. JobRunner assembly stage runs with beat checkpoints and resumes without redoing finished units', async () => {
    const jobOutputDir = path.join(tempDir, 'job_run');
    await fs.mkdir(jobOutputDir, { recursive: true });

    const videoId = 'vid-resume-test';
    const jobId = 'job-resume-test';

    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: videoId,
          title: 'Resume Test Video',
          status: 'voicing',
          script_json: {
            beats: [
              { index: 0, text: 'Beat 0 narration' },
              { index: 1, text: 'Beat 1 narration' },
            ],
          },
        },
      ],
      video_assets: [
        { video_id: videoId, beat_index: 0, visual_type: 'uploaded', source_url: testImage },
        { video_id: videoId, beat_index: 1, visual_type: 'uploaded', source_url: testShortVideo },
      ],
      yt_jobs: [
        {
          id: jobId,
          video_id: videoId,
          topic: 'Resume Test',
          template: 'tech-explainer',
          status: 'running',
          stages: ['assembly'],
          script: {
            scenes: [
              { scene_number: 0, narration: 'Beat 0 narration', visual_prompt: 'prompt 0' },
              { scene_number: 1, narration: 'Beat 1 narration', visual_prompt: 'prompt 1' },
            ],
          },
        },
      ],
      yt_job_units: [
        // TTS completed units from previous stage
        {
          job_id: jobId,
          stage: 'tts',
          unit_index: 0,
          status: 'done',
          output_path: testAudio1,
          duration_ms: 2000,
          input_hash: 'hash-tts-0',
        },
        {
          job_id: jobId,
          stage: 'tts',
          unit_index: 1,
          status: 'done',
          output_path: testAudio2,
          duration_ms: 1500,
          input_hash: 'hash-tts-1',
        },
      ],
    });

    const runner = new JobRunner({
      jobId,
      supabase,
      baseOutputDir: jobOutputDir,
    });

    // Run first time
    const finalVideoPath = await runner.runAssemblyStage();
    assert.ok(finalVideoPath);

    const exists = await fs.stat(finalVideoPath).then((s) => s.isFile()).catch(() => false);
    assert.ok(exists, 'Final video should exist on disk');

    // Verify unit checkpoints were created for both beats
    const assemblyUnits = db.yt_job_units.filter(
      (u) => u.job_id === jobId && u.stage === 'assembly',
    );
    assert.equal(assemblyUnits.length, 2);
    assert.equal(assemblyUnits[0].status, 'done');
    assert.equal(assemblyUnits[1].status, 'done');

    // Note the output_path of beat 0
    const beat0Clip = assemblyUnits[0].output_path;
    assert.ok(beat0Clip && (await fs.stat(beat0Clip)).isFile());

    // Record mtime of beat 0 clip
    const mtime1 = (await fs.stat(beat0Clip)).mtimeMs;

    // Run a second time (simulating resume/rerun)
    await runner.runAssemblyStage();

    const mtime2 = (await fs.stat(beat0Clip)).mtimeMs;
    // Beat 0 should NOT have been re-rendered!
    assert.equal(mtime1, mtime2, 'Finished assembly unit should be skipped on resume');

    // Verify video record status is rendered
    const videoRec = db.videos.find((v) => v.id === videoId);
    assert.equal(videoRec?.status, 'rendered');
    assert.equal(videoRec?.render_url, `/api/videos/${videoId}/render`);
  });

  it('5b. Topic-only job (no video_id) assembles 1-based scene_numbers using their own units', async () => {
    const jobOutputDir = path.join(tempDir, 'job_one_based');
    await fs.mkdir(jobOutputDir, { recursive: true });

    const jobId = 'job-one-based-test';
    const { supabase, db } = createMockSupabase({
      yt_jobs: [
        {
          id: jobId,
          video_id: null,
          topic: 'One-based Test',
          template: 'tech-explainer',
          status: 'running',
          stages: ['assembly'],
          script: {
            scenes: [
              { scene_number: 1, narration: 'Scene 1 narration', visual_prompt: 'prompt 1' },
              { scene_number: 2, narration: 'Scene 2 narration', visual_prompt: 'prompt 2' },
            ],
          },
        },
      ],
      yt_job_units: [
        { job_id: jobId, stage: 'tts', unit_index: 1, status: 'done', output_path: testAudio1, duration_ms: 2000 },
        { job_id: jobId, stage: 'tts', unit_index: 2, status: 'done', output_path: testAudio2, duration_ms: 1500 },
        { job_id: jobId, stage: 'image', unit_index: 1, status: 'done', output_path: testImage },
        { job_id: jobId, stage: 'image', unit_index: 2, status: 'done', output_path: testImage },
      ],
    });

    const runner = new JobRunner({ jobId, supabase, baseOutputDir: jobOutputDir });
    const finalVideoPath = await runner.runAssemblyStage();

    assert.ok((await fs.stat(finalVideoPath)).isFile(), 'Final video should exist on disk');
    const assemblyIndexes = db.yt_job_units
      .filter((u) => u.job_id === jobId && u.stage === 'assembly' && u.status === 'done')
      .map((u) => u.unit_index)
      .sort();
    assert.deepEqual(assemblyIndexes, [1, 2]);
  });

  it('5c. Separate assembly job uses visuals generated by the earlier voicing job, and burns captions', async () => {
    const videoId = 'vid-generated-visuals';
    const voiceJobId = 'job-voice-and-visuals';
    const assemblyJobId = 'job-assembly-only';
    const jobOutputDir = path.join(tempDir, 'job_generated_visuals');
    await fs.mkdir(jobOutputDir, { recursive: true });

    const { supabase, db } = createMockSupabase({
      videos: [
        {
          id: videoId,
          status: 'voicing',
          script_json: {
            beats: [
              { index: 0, text: 'Revenue doubled to 40 billion dollars', visual_type: 'chart' },
              { index: 1, text: 'Ships sailed from London to New York', visual_type: 'geo_map' },
            ],
            captions: { preset: 'vox' },
          },
        },
      ],
      // Generated visuals record provenance with no local source_url
      video_assets: [
        { video_id: videoId, beat_index: 0, visual_type: 'chart', source_url: null },
        { video_id: videoId, beat_index: 1, visual_type: 'geo_map', source_url: null },
      ],
      yt_jobs: [
        { id: voiceJobId, video_id: videoId, status: 'done', created_at: '2026-01-01T00:00:00Z' },
        {
          id: assemblyJobId,
          video_id: videoId,
          status: 'running',
          stages: ['assembly'],
          created_at: '2026-01-02T00:00:00Z',
        },
      ],
      yt_job_units: [
        { job_id: voiceJobId, stage: 'tts', unit_index: 0, status: 'done', output_path: testAudio1, duration_ms: 2000 },
        { job_id: voiceJobId, stage: 'tts', unit_index: 1, status: 'done', output_path: testAudio2, duration_ms: 1500 },
        { job_id: voiceJobId, stage: 'visuals', unit_index: 0, status: 'done', output_path: testImage },
        { job_id: voiceJobId, stage: 'visuals', unit_index: 1, status: 'done', output_path: testShortVideo },
      ],
    });

    const runner = new JobRunner({ jobId: assemblyJobId, supabase, baseOutputDir: jobOutputDir });
    const finalVideoPath = await runner.runAssemblyStage();

    assert.ok((await fs.stat(finalVideoPath)).isFile(), 'Final video should exist on disk');
    const assContent = await fs.readFile(
      path.join(jobOutputDir, 'temp_assembly', 'captions.ass'),
      'utf-8',
    );
    assert.ok(assContent.includes('Style: VoxMinimal'));
    // Beat 1 captions start after beat 0's full clip (2.0s speech + 0.5s default pause), not at 2.0s
    const beat1Line = assContent.split('\n').find((l) => l.includes('&}Ships'));
    const beat1Start = beat1Line?.match(/^Dialogue: 0,0:00:(\d+\.\d+),/)?.[1];
    assert.ok(beat1Start, 'Expected a caption line for beat 1');
    assert.ok(
      Number(beat1Start) >= 2.4 && Number(beat1Start) <= 2.7,
      `Beat 1 captions should start ~2.5s, got ${beat1Start}s`,
    );
    assert.equal(db.videos[0].status, 'rendered');
  });

  it('6. GET /api/videos/[id]/render serves video and supports HTTP 206 Range requests', async () => {
    const videoId = 'vid-render-route-test';
    const rendersDir = path.join(process.cwd(), 'storage', 'renders', videoId);
    await fs.mkdir(rendersDir, { recursive: true });
    const finalVideo = path.join(rendersDir, 'final_video.mp4');
    await fs.copyFile(testShortVideo, finalVideo);

    try {
      const { supabase } = createMockSupabase({
        videos: [{ id: videoId, render_url: `/api/videos/${videoId}/render` }],
      });

      // 1. Full request
      const fullReq = new Request(`http://localhost:3000/api/videos/${videoId}/render`);
      const fullRes = await handleGetRender(fullReq, videoId, supabase);
      assert.equal(fullRes.status, 200);
      assert.equal(fullRes.headers.get('Content-Type'), 'video/mp4');
      assert.equal(fullRes.headers.get('Accept-Ranges'), 'bytes');

      // 2. Range request (bytes=0-100)
      const rangeReq = new Request(`http://localhost:3000/api/videos/${videoId}/render`, {
        headers: { Range: 'bytes=0-100' },
      });
      const rangeRes = await handleGetRender(rangeReq, videoId, supabase);
      assert.equal(rangeRes.status, 206);
      assert.equal(rangeRes.headers.get('Content-Range')?.startsWith('bytes 0-100/'), true);
      assert.equal(rangeRes.headers.get('Content-Length'), '101');
    } finally {
      await fs.rm(rendersDir, { recursive: true, force: true });
    }
  });

  it('7. Blurred background padding renders non-16:9 vertical video to 1920x1080 with exact audio duration', async () => {
    const verticalVideo = path.join(tempDir, 'vert_video.mp4');
    await execFileAsync(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=360x640:rate=30',
      '-t',
      '1.0',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      verticalVideo,
    ]);

    const blurOut = path.join(tempDir, 'vert_blur_out.mp4');
    await renderBeatScene({
      visualPath: verticalVideo,
      audioPath: testAudio1,
      durationMs: 2000,
      outputPath: blurOut,
      isVideo: true,
      padStyle: 'blur',
      shortVideoBehavior: 'hold',
    });

    const exists = await fs.stat(blurOut).then((s) => s.isFile() && s.size > 0);
    assert.ok(exists, 'Rendered blur output must exist');

    const durationMs = await getVideoDurationMs(blurOut);
    assert.ok(
      Math.abs(durationMs - 2000) <= 100,
      `Duration ${durationMs}ms should match audio ~2000ms`,
    );
  });

  it('8. Blurred background padding renders square image to 1920x1080 with exact audio duration', async () => {
    const squareImage = path.join(tempDir, 'square_img.png');
    await execFileAsync(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=purple:s=400x400',
      '-frames:v',
      '1',
      squareImage,
    ]);

    const blurOut = path.join(tempDir, 'square_blur_out.mp4');
    await renderBeatScene({
      visualPath: squareImage,
      audioPath: testAudio2,
      durationMs: 1500,
      outputPath: blurOut,
      isVideo: false,
      padStyle: 'blur',
      stillMotion: 'static',
    });

    const exists = await fs.stat(blurOut).then((s) => s.isFile() && s.size > 0);
    assert.ok(exists, 'Rendered square blur output must exist');

    const durationMs = await getVideoDurationMs(blurOut);
    assert.ok(
      Math.abs(durationMs - 1500) <= 100,
      `Duration ${durationMs}ms should match audio ~1500ms`,
    );
  });
});
