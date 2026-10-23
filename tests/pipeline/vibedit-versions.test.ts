import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareVersion, deleteVersion, listVersions, restoreVersion, saveVersion } from '../../src/pipeline/vibedit/versions.ts';
import { shotClipPath, sidecarPath } from '../../src/pipeline/visuals/shot-editor.ts';
import { rendersDir } from '../../src/pipeline/publish/publish-assets.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);
const colorClip = (color: string, file: string) =>
  execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=30:d=1`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
const shot = (type: string, query: string) => ({ renderedType: type, plannedType: type, startSec: 0, durationSec: 1, frames: 30, plan: { visual_type: type, visual_query: query } });

describe('Vibedit version history', () => {
  const videoId = `test-versions-${Date.now()}`;
  let dir: string;
  let track: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'versions-'));
    track = path.join(dir, 'beat_0_track.mp4');
    await fs.mkdir(path.dirname(shotClipPath(track, 0, 0)), { recursive: true });
    await colorClip('red', shotClipPath(track, 0, 0));
    await colorClip('blue', shotClipPath(track, 0, 1));
    await fs.writeFile(track, 'track');
    await fs.writeFile(sidecarPath(track), JSON.stringify({ beatIndex: 0, shots: [shot('stock', 'harbour'), shot('kinetic_text', 'Quiet')] }));
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(rendersDir(videoId), { recursive: true, force: true });
  });

  it('saves, compares, restores (saving the current state first) and deletes versions', async () => {
    const { supabase, db } = createMockSupabase({
      videos: [{ id: videoId, script_json: { beats: [{ text: 'One.' }, { text: 'Two.' }], caption_edits: { 1: { basis: ['Two.'], hidden: true } } } }],
      video_assets: [
        { id: 'a0', video_id: videoId, beat_index: 0, visual_type: 'composite', source_url: track, license_type: 'mixed' },
        { id: 'a1', video_id: videoId, beat_index: 1, visual_type: 'uploaded', source_url: 'first.png' },
      ],
      yt_jobs: [],
    });
    const pool = path.join(rendersDir(videoId), 'vibedit-versions', 'pool');

    const v1 = await saveVersion(supabase, videoId, 'Original cut');
    assert.equal((await fs.readdir(pool)).length, 2);
    await saveVersion(supabase, videoId, 'Same again');
    assert.equal((await fs.readdir(pool)).length, 2, 'unchanged clips are stored once');
    assert.deepEqual(await compareVersion(supabase, videoId, v1.id), [], 'nothing changed yet');

    // Edit: the text card becomes footage (a new clip, renamed into place like the shot editor),
    // the plain beat gets another upload, and the caption edits are cleared
    await colorClip('green', `${shotClipPath(track, 0, 1)}.new.mp4`);
    await fs.rename(`${shotClipPath(track, 0, 1)}.new.mp4`, shotClipPath(track, 0, 1));
    await fs.writeFile(sidecarPath(track), JSON.stringify({ beatIndex: 0, shots: [shot('stock', 'harbour'), shot('archive', 'old docks')] }));
    db.video_assets[1].source_url = 'second.png';
    db.videos[0].script_json.caption_edits = {};

    const diff = await compareVersion(supabase, videoId, v1.id);
    assert.deepEqual(diff.map((d) => d.beat), [0, 1]);
    assert.deepEqual(diff[0].then, ['stock: harbour', 'kinetic_text: Quiet']);
    assert.deepEqual(diff[0].now, ['stock: harbour', 'archive: old docks']);

    const { restoredBeats, backup } = await restoreVersion(supabase, videoId, v1.id);
    assert.deepEqual(restoredBeats, [0, 1]);
    assert.match(backup.label, /Before restoring "Original cut"/);
    assert.deepEqual(await compareVersion(supabase, videoId, v1.id), [], 'back to the original');
    assert.equal(JSON.parse(await fs.readFile(sidecarPath(track), 'utf-8')).shots[1].renderedType, 'kinetic_text');
    assert.equal(db.video_assets.find((a) => a.beat_index === 1)!.source_url, 'first.png');
    assert.deepEqual(db.videos[0].script_json.caption_edits, { 1: { basis: ['Two.'], hidden: true } });
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', track]);
    assert.ok(Math.abs(Number.parseFloat(stdout) - 2) < 0.1, 'the track is rebuilt from the restored clips');

    // The backup can bring the edit back
    assert.deepEqual((await compareVersion(supabase, videoId, backup.id)).map((d) => d.beat), [0, 1]);

    assert.equal((await listVersions(videoId)).length, 3);
    await deleteVersion(videoId, backup.id);
    assert.equal((await fs.readdir(pool)).length, 2, "the edit's green clip went with the only version using it");
    await assert.rejects(restoreVersion(supabase, videoId, backup.id), /no longer exists/);
  });
});
