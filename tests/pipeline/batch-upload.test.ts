import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { composeBeatTrack } from '../../src/pipeline/visuals/shot-composer.ts';
import { makeColorClip } from '../../src/pipeline/visuals/clips.ts';
import { loadComposedBeat, shotClipPath, sidecarPath } from '../../src/pipeline/visuals/shot-editor.ts';
import { editShot } from '../../src/pipeline/visuals/shot-editor-actions.ts';
import { buildMatchPrompt, frameTimes, MIN_MATCH_SCORE, normalizeMatches, type MatchTarget, type StagedFile } from '../../src/pipeline/visuals/smart-match.ts';
import { addToLibrary, listLibrary, removeFromLibrary, searchLibrary } from '../../src/pipeline/visuals/clip-library.ts';
import type { ShotPlan } from '../../src/lib/script/generate-script.ts';

const execFileAsync = promisify(execFile);

async function frameCount(file: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
  return Number(stdout.trim().replace(/,$/, ''));
}

/** Just enough of the Supabase client: one video_assets row, writes recorded. */
function fakeDb(asset: Record<string, unknown> | null) {
  const writes: Array<Record<string, unknown>> = [];
  const from = (table: string) => {
    let op = 'select';
    let payload: Record<string, unknown> | null = null;
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      delete: () => ((op = 'delete'), q),
      update: (p: Record<string, unknown>) => ((op = 'update'), (payload = p), q),
      insert: (p: Record<string, unknown>) => ((op = 'insert'), (payload = p), q),
      maybeSingle: async () => ({ data: table === 'video_assets' && asset ? { id: 'asset-1', ...asset } : null, error: null }),
      single: async () => ({ data: null, error: { message: 'none' } }),
      then: (resolve: (v: unknown) => unknown) => {
        if ((op === 'update' || op === 'insert') && payload) {
          writes.push(payload);
          if (table === 'video_assets' && asset) Object.assign(asset, payload);
        }
        return Promise.resolve({ data: table === 'yt_jobs' ? [] : null, error: null }).then(resolve);
      },
    };
    return q;
  };
  return { client: { from } as never, writes };
}

const plan = (word_start: number, word_count: number, visual_query: string): ShotPlan => ({ visual_type: 'stock', visual_query, covers: visual_query, word_start, word_count });

describe('Upload into one shot', () => {
  let dir: string;
  let trackPath: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shot-upload-'));
    const composed = await composeBeatTrack({
      beatIndex: 1,
      shots: [plan(0, 4, 'first'), plan(4, 4, 'second'), plan(8, 4, 'third')],
      words: null,
      audioDurationSec: 2.5,
      outputDir: dir,
      renderShot: async (slot, clipPath) => {
        await makeColorClip('#223344', slot.frames, clipPath);
        return { clipPath, renderedType: 'stock', license: 'royalty_free', sourceUrl: `https://stock.test/${slot.shot.visual_query}` };
      },
    });
    trackPath = composed.trackPath;
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('puts your clip in one shot, keeps the rest and the beat length, and credits it as yours', async () => {
    const upload = path.join(dir, 'mine.mp4');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-t', '4', '-pix_fmt', 'yuv420p', upload]);
    const db = fakeDb({ visual_type: 'composite', source_url: trackPath });
    const beat = (await loadComposedBeat(db.client, 'v1', 1))!;
    const before = await fs.readFile(shotClipPath(trackPath, 1, 2));

    const shot = await editShot({
      supabase: db.client,
      videoId: 'v1',
      beat,
      shotIndex: 1,
      edit: { action: 'upload', filePath: upload, mediaType: 'video', license: 'own_work', startSec: 1 },
    });

    assert.equal(shot.license, 'own_work');
    assert.match(shot.note ?? '', /uploaded by you/);
    assert.equal(await frameCount(trackPath), 75, 'the beat keeps its length');
    assert.deepEqual(await fs.readFile(shotClipPath(trackPath, 1, 2)), before, 'other shots are untouched');
    const sidecar = JSON.parse(await fs.readFile(sidecarPath(trackPath), 'utf-8'));
    assert.equal(sidecar.shots[1].plan.visual_query, 'second', 'the plan stays, so the shot can be changed again');
  });
});

describe('Smart matching', () => {
  const staged = (id: string, isVideo: boolean, durationSec: number): StagedFile => ({ id, name: `${id}.mp4`, path: `/x/${id}`, isVideo, durationSec });
  const targets: MatchTarget[] = [
    { beat_index: 0, shot_index: 1, query: 'Sarajevo motorcade 1914', covers: 'The cars turn', durationSec: 4 },
    { beat_index: 3, shot_index: 0, query: 'crowd outside a courthouse', covers: 'Crowds gathered', durationSec: 5 },
    { beat_index: 5, shot_index: null, query: 'river bridge', covers: 'The Latin Bridge', durationSec: 6 },
  ];

  it('looks at a long clip every few seconds, never more than eight times', () => {
    assert.deepEqual(frameTimes(6), [1.5, 4.5]);
    assert.equal(frameTimes(600).length, 8);
    assert.deepEqual(frameTimes(0), [0]);
  });

  it('shows every shot and every frame with its time', () => {
    const prompt = buildMatchPrompt(
      [
        { label: 1, name: 'drone.mp4', isVideo: true, durationSec: 30, frames: [5, 15, 25] },
        { label: 2, name: 'bridge.jpg', isVideo: false, durationSec: 0, frames: [] },
      ],
      targets,
    );
    assert.match(prompt, /T1 \(4\.0 s\): Sarajevo motorcade 1914/);
    assert.match(prompt, /file 1 "drone\.mp4" \(video, 30 s\) at 15 s/);
    assert.match(prompt, /file 2 "bridge\.jpg" \(photo\)/);
    assert.match(prompt, /A long video can serve several shots/);
  });

  it('keeps the best match per shot, lets one long clip fill several shots without reusing seconds', () => {
    const files = [
      { label: 1, staged: staged('long', true, 30) },
      { label: 2, staged: staged('photo', false, 0) },
    ];
    const out = normalizeMatches(
      [
        { file: 1, start_sec: 2, target: 1, score: 9, reason: 'motorcade' },
        { file: 1, start_sec: 4, target: 2, score: 8, reason: 'overlaps the first use' },
        { file: 1, start_sec: 20, target: 2, score: 7, reason: 'crowd later in the clip' },
        { file: 2, start_sec: 3, target: 3, score: 8, reason: 'the bridge' },
        { file: 2, start_sec: 0, target: 1, score: 6.5, reason: 'worse than the film' },
        { file: 1, start_sec: 29, target: 3, score: MIN_MATCH_SCORE - 1, reason: 'weak' },
        { file: 9, start_sec: 0, target: 1, score: 10, reason: 'no such file' },
      ],
      files,
      targets,
    );
    assert.deepEqual(
      out.map((p) => [p.fileId, p.beat_index, p.shot_index, p.startSec]),
      [
        ['long', 0, 1, 2],
        ['long', 3, 0, 20],
        ['photo', 5, null, 0],
      ],
    );
  });

  it('never starts a clip so late that the shot runs past its end', () => {
    const [p] = normalizeMatches([{ file: 1, start_sec: 28, target: 2, score: 8, reason: 'end' }], [{ label: 1, staged: staged('long', true, 30) }], targets);
    assert.equal(p.startSec, 25);
  });
});

describe('Clip library', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'library-'));
    process.env.CLIP_LIBRARY_DIR = dir;
  });
  after(async () => {
    delete process.env.CLIP_LIBRARY_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('adds a clip with a thumbnail, finds it by subject, and removes it', async () => {
    const src = path.join(dir, 'src.mp4');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-t', '3', '-pix_fmt', 'yuv420p', src]);
    // Without a model it's described by its file name
    const clip = await addToLibrary(null, { name: 'stadium_crowd_night.mp4', buffer: await fs.readFile(src), license: 'own_work' });
    assert.equal(clip.description, 'stadium crowd night');
    assert.ok(clip.isVideo);
    assert.ok((await fs.stat(clip.thumbPath)).size > 0);
    assert.equal((await listLibrary()).length, 1);

    const found = searchLibrary('Crowd at the stadium before kick-off', await listLibrary());
    assert.equal(found.length, 1);
    assert.equal(found[0].provider, 'uploaded');
    assert.equal(found[0].downloadUrl, clip.path);
    assert.equal(found[0].pageUrl, `library:${clip.id}`);
    assert.equal(searchLibrary('Apollo rocket launch', await listLibrary()).length, 0);

    assert.equal(await removeFromLibrary(clip.id), true);
    assert.equal((await listLibrary()).length, 0);
    await assert.rejects(fs.stat(clip.path));
  });

  it('rejects files that are not video or images', async () => {
    await assert.rejects(addToLibrary(null, { name: 'notes.txt', buffer: Buffer.from('hello world, not media'), license: 'own_work' }), /unsupported file/);
  });
});
