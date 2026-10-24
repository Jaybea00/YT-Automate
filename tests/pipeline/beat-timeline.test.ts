import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beatTimelineView, moveCut, reorderShots } from '../../src/pipeline/vibedit/beat-timeline.ts';
import { shotClipPath, sidecarPath } from '../../src/pipeline/visuals/shot-editor.ts';
import { saveWordTimings } from '../../src/pipeline/tts/word-timings.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);
const colorClip = (color: string, frames: number, file: string) =>
  execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30`, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', '30', '-an', file]);
const frames = async (file: string) =>
  Number((await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file])).stdout.trim());
const redAt = async (file: string, frame: number) => {
  const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),format=rgb24,crop=1:1:160:90`, '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
  return Array.from(stdout as Buffer);
};
const shot = (type: string, query: string, startSec: number) => ({
  renderedType: type,
  plannedType: type,
  startSec,
  durationSec: 1,
  frames: 30,
  plan: { visual_type: type, visual_query: query, covers: '', word_start: 0, word_count: 1 },
});

describe('Vibedit beat timeline', () => {
  let dir: string;
  let track: string;
  let voice: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-'));
    track = path.join(dir, 'beat_0_track.mp4');
    await fs.mkdir(path.dirname(shotClipPath(track, 0, 0)), { recursive: true });
    for (const [i, c] of ['red', 'green', 'blue'].entries()) await colorClip(c, 30, shotClipPath(track, 0, i));
    await fs.writeFile(track, 'track');
    await fs.writeFile(
      sidecarPath(track),
      JSON.stringify({ beatIndex: 0, leadInSec: 0.2, tailSec: 0.3, shots: [shot('kinetic_text', 'Red', 0), shot('chart', 'Green', 1), shot('title', 'Blue', 2)] }),
    );
    voice = path.join(dir, 'beat_0.mp3');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:r=24000:d=2.4', '-c:a', 'libmp3lame', voice]);
    await saveWordTimings(voice, {
      version: 1,
      source: 'provider',
      text: 'One two three.',
      spokenText: 'One two three.',
      durationMs: 2400,
      words: [
        { word: 'One', start: 0, end: 0.6 },
        { word: 'two', start: 0.8, end: 1.4 },
        { word: 'three.', start: 1.6, end: 2.3 },
      ],
    } as never);
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const db = () =>
    createMockSupabase({
      videos: [{ id: 'v-tl', script_json: { beats: [{ text: 'One two three.' }] } }],
      video_assets: [{ id: 'a0', video_id: 'v-tl', beat_index: 0, visual_type: 'composite', source_url: track }],
      yt_jobs: [{ id: 'j1', video_id: 'v-tl', created_at: '2026-10-01T00:00:00Z' }],
      yt_job_units: [{ job_id: 'j1', stage: 'tts', unit_index: 0, status: 'done', output_path: voice }],
    }).supabase;

  it('shows the shots over the voice: waveform and words placed after the lead-in', async () => {
    const view = await beatTimelineView(db(), 'v-tl', 0);
    assert.deepEqual(view.shots.map((s) => [s.type, s.kind, s.startSec]), [['kinetic_text', 'text', 0], ['chart', 'graphic', 1], ['title', 'text', 2]]);
    assert.equal(view.totalSec, 3);
    assert.deepEqual(view.words.map((w) => w.start), [0.2, 1, 1.8]);
    assert.ok(Math.abs(view.peaks.length - 120) <= 3, `about 50 peaks a second (${view.peaks.length})`);
    assert.ok(Math.max(...view.peaks) > 0.1, "the sine source plays at 1/8 of full scale");
  });

  it('reorders shots without re-rendering, then moves a cut keeping each picture', async () => {
    const supabase = db();
    let view = await reorderShots(supabase, 'v-tl', 0, [2, 0, 1]);
    assert.deepEqual(view.shots.map((s) => s.label), ['Blue', 'Red', 'Green']);
    assert.deepEqual(view.shots.map((s) => s.startSec), [0, 1, 2]);
    assert.ok((await redAt(shotClipPath(track, 0, 0), 5))[2] > 200, 'the blue clip is now first');
    assert.equal(await frames(track), 90);

    view = await moveCut(supabase, 'v-tl', 0, 0, 15);
    assert.deepEqual(view.shots.map((s) => s.frames), [45, 15, 30]);
    assert.deepEqual(view.shots.map((s) => s.startSec), [0, 1.5, 2]);
    assert.equal(await frames(shotClipPath(track, 0, 0)), 45, 'the longer shot holds its last frame');
    assert.ok((await redAt(shotClipPath(track, 0, 0), 44))[2] > 200, 'still blue');
    assert.ok((await redAt(shotClipPath(track, 0, 1), 10))[0] > 200, 'the shorter one is still red');
    assert.equal(await frames(track), 90, 'the beat keeps its length');

    await assert.rejects(moveCut(supabase, 'v-tl', 0, 0, 10), /too short/);
    await assert.rejects(reorderShots(supabase, 'v-tl', 0, [0, 0, 1]), /every shot once/);
  });
});
