import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fallbackShortPlans, normalizeShortPlans, renderShort, spanOf, SHORT_HEIGHT, SHORT_WIDTH } from '../../src/pipeline/publish/shorts.ts';
import { publishFilePath, publishView, saveEdits, writePackage } from '../../src/pipeline/publish/publish-service.ts';
import { rendersDir } from '../../src/pipeline/publish/publish-assets.ts';
import type { VideoTimeline } from '../../src/pipeline/utils/timeline.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);

/** Ten 8-second beats, each opening with a 0.2 s lead-in. */
const timeline: VideoTimeline = {
  version: 1,
  renderedAt: '',
  totalMs: 80_000,
  beats: Array.from({ length: 10 }, (_, i) => ({
    index: i, sceneStartMs: i * 8000, sceneMs: 8000, voiceStartMs: i * 8000 + 200, voiceMs: 7000, audioPath: null, trackPath: null,
  })),
};

describe('Shorts', () => {
  it('spans whole beats, opening on the voice', () => {
    assert.deepEqual(spanOf(timeline, 2, 4), { startSec: 16.2, endSec: 40 });
    assert.equal(spanOf(timeline, 4, 2), null);
  });

  it('keeps Shorts between 20 and 59 seconds, without overlaps, with short hooks', () => {
    const plans = normalizeShortPlans(
      [
        { startBeat: 0, endBeat: 9, title: 'Too long, trimmed', hook: 'the whole story in one short clip today' },
        { startBeat: 5, endBeat: 6, title: 'Too short', hook: 'x' },
        { startBeat: 3, endBeat: 6, title: 'Overlaps the first', hook: 'y' },
        { startBeat: 8, endBeat: 9, title: 'Too short too', hook: 'z' },
      ],
      timeline,
    );
    assert.equal(plans.length, 1);
    assert.deepEqual([plans[0].startBeat, plans[0].endBeat], [0, 6], 'trimmed by whole beats to 55.8 s');
    assert.equal(plans[0].hook, 'THE WHOLE STORY IN ONE SHORT');
    assert.deepEqual(fallbackShortPlans(timeline, [0, 5], 'T').map((p) => [p.startBeat, p.endBeat]), [[0, 4], [5, 9]]);
  });

  let dir: string;
  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shorts-'));
  });
  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('renders a vertical 1080x1920 clip of the chosen stretch', async () => {
    const source = path.join(dir, 'final.mp4');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30', '-f', 'lavfi', '-i', 'sine=f=300:r=48000', '-t', '6',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    const small: VideoTimeline = { ...timeline, totalMs: 6000, beats: [{ index: 0, sceneStartMs: 0, sceneMs: 3000, voiceStartMs: 200, voiceMs: 2500, audioPath: null, trackPath: null }] };
    const clip = await renderShort({
      videoPath: source,
      plan: { startBeat: 0, endBeat: 0, title: 'Test', hook: 'A HOOK' },
      timeline: small,
      beats: [{ index: 0, text: 'Words heard here' }],
      words: {},
      highlightHex: '#e3b04b',
      outPath: path.join(dir, 'short_1.mp4'),
    });
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'csv=p=0', clip.path]);
    const [dims, duration] = stdout.trim().split(/\r?\n/);
    assert.equal(dims.replace(/,$/, ''), `${SHORT_WIDTH},${SHORT_HEIGHT}`);
    assert.ok(Math.abs(Number.parseFloat(duration) - 2.8) < 0.15, `opens on the voice and ends with the scene (${duration})`);
  });
});

describe('Publish service', () => {
  const videoId = 'publish-test-video';
  const renders = rendersDir(videoId);
  before(async () => {
    await fsp.mkdir(path.join(renders, 'thumbnails'), { recursive: true });
    await fsp.writeFile(path.join(renders, 'final_video.mp4'), 'video bytes');
    await fsp.writeFile(path.join(renders, 'thumbnails', 'thumbnail_1.jpg'), 'jpeg bytes');
  });
  after(async () => {
    await fsp.rm(renders, { recursive: true, force: true });
  });

  const video = () => ({
    id: videoId,
    title: 'Working title',
    topic: '1929',
    style: 'story_driven',
    status: 'rendered',
    script_json: {
      beats: [{ text: 'Beat.' }],
      formatted_chapters: '00:00 - Start\n00:30 - Middle\n01:00 - End',
      music_credits: ['"Sad Trio" Kevin MacLeod'],
      publish: {
        metadata: { titles: [{ text: 'The Day It Broke', angle: 'story' }], hook: 'Hook line.', summary: 'Summary.', tags: ['crash'], hashtags: ['#History'], generatedAt: '' },
        thumbnails: [{ frame: 0, text: 'PANIC', highlight: 'PANIC', side: 'left' as const, atSec: 3, path: path.join(renders, 'thumbnails', 'thumbnail_1.jpg') }],
      },
    },
  });

  it('builds the description from the hook, chapters, credits and hashtags, with edits taking precedence', async () => {
    const { supabase, db } = createMockSupabase({ videos: [video()], video_assets: [{ video_id: videoId, license_type: 'cc_by', attribution_text: 'Photo by A' }] });
    const view = await publishView(supabase, video());
    assert.equal(view.title, 'The Day It Broke');
    assert.equal(view.rendered, true);
    assert.match(view.description, /^Hook line\.\n\nSummary\.\n\nChapters:\n00:00 - Start/);
    assert.match(view.description, /Credits:\nMusic:\n"Sad Trio" Kevin MacLeod\n\nImages and footage:\n• Photo by A \(CC BY\)\n\n#History$/);

    await saveEdits(supabase, videoId, { title: 'My own title' });
    const edited = await publishView(supabase, db.videos[0] as never);
    assert.equal(edited.title, 'My own title');
    assert.equal(edited.edited, true);
  });

  it('serves only files inside the video\'s own render folder', () => {
    assert.ok(publishFilePath(video(), 'thumbnail', 1)?.endsWith('thumbnail_1.jpg'));
    assert.equal(publishFilePath(video(), 'thumbnail', 2), null);
    const escaped = video();
    escaped.script_json.publish.thumbnails[0].path = path.join(os.tmpdir(), 'elsewhere.jpg');
    assert.equal(publishFilePath(escaped, 'thumbnail', 1), null);
  });

  it('packages the video, thumbnails and YouTube text into a zip', async () => {
    const { supabase } = createMockSupabase({ videos: [video()], video_assets: [] });
    const zipPath = path.join(os.tmpdir(), `package-${Date.now()}.zip`);
    await writePackage(supabase, video(), fs.createWriteStream(zipPath));
    // Windows' own tar (bsdtar) lists zips; Git's GNU tar on PATH can't
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'unzip';
    const { stdout } = await execFileAsync(tar, process.platform === 'win32' ? ['-tf', zipPath] : ['-Z1', zipPath]);
    const entries = stdout.trim().split(/\r?\n/).sort();
    assert.deepEqual(entries, ['The_Day_It_Broke.mp4', 'The_Day_It_Broke.srt', 'thumbnails/thumbnail_1.jpg', 'youtube.txt']);
    await fsp.unlink(zipPath).catch(() => {});
  });
});
