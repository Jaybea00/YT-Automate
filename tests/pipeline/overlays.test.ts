import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeOverlay, overlayWindows, overlaysGraph, readOverlays, renderOverlayPngs } from '../../src/pipeline/assembly/overlays.ts';
import { masterFinalVideo } from '../../src/pipeline/assembly/master.ts';
import { addOverlay, deleteOverlay, listOverlays, updateOverlay } from '../../src/pipeline/vibedit/overlays-store.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);

describe('Text, callouts and arrows', () => {
  it('cleans overlays and times them from their beats', () => {
    assert.equal(normalizeOverlay({ kind: 'text', beat: 0, offsetSec: 1, x: 0.5, y: 0.5, text: '  ' }), null, 'text needs words');
    const arrow = normalizeOverlay({ kind: 'arrow', beat: 2, offsetSec: -3, durationSec: 99, x: 1.4, y: 0.25, text: '' }, 'a1')!;
    assert.deepEqual([arrow.offsetSec, arrow.durationSec, arrow.x, arrow.y], [0, 15, 1, 0.25]);
    assert.equal(readOverlays([{ kind: 'nope' }, arrow]).length, 1);

    const windows = overlayWindows(
      [
        { ...arrow, beat: 2, offsetSec: 1, durationSec: 3 },
        { ...arrow, id: 'gone', beat: 9 },
        { ...arrow, id: 'late', beat: 1, offsetSec: 4, durationSec: 5 },
      ],
      { 1: 5, 2: 12 },
      10,
    );
    // "late" is cut at the video's end; a1 starts after it ends (dropped), "gone" has no beat in the video
    assert.deepEqual(windows.map((w) => [w.id, w.atSec, w.endSec]), [['late', 9, 10]]);
    assert.match(overlaysGraph([{ atSec: 2, endSec: 4 }, { atSec: 5, endSec: 6 }], 3), /\[3:v\].*\[vfx\]\[ovl0\]overlay.*\[4:v\].*\[ovc0\]\[ovl1\]overlay.*\[vov\]$/);
  });

  it('draws an overlay over the picture only while it is on', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlays-'));
    try {
      const program = path.join(dir, 'program.mp4');
      await execFileAsync('ffmpeg', [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=1920x1080:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=4',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', program,
      ]);
      const overlay = normalizeOverlay({ kind: 'text', beat: 0, offsetSec: 1.5, durationSec: 1.5, text: 'THREE DAYS LATER', x: 0.5, y: 0.5 }, 't1')!;
      const windows = overlayWindows([overlay], { 0: 0 }, 4);
      const pngs = await renderOverlayPngs(themeForStyle('history'), windows, path.join(dir, 'png'));
      const out = path.join(dir, 'master.mp4');
      await masterFinalVideo({ inputPath: program, outputPath: out, overlays: { windows, pngs } });

      const centre = async (t: number) => {
        const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'format=rgb24,crop=1:1:960:540', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
        return (stdout as Buffer)[0];
      };
      assert.ok((await centre(0.8)) > 200, 'nothing before its moment');
      assert.ok((await centre(2.3)) < 120, 'the dark text box is there during its moment');
      assert.ok((await centre(3.6)) > 200, 'gone after');
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
      assert.ok(Math.abs(Number.parseFloat(stdout) - 4) < 0.1, 'the still overlay input does not lengthen the video');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('stores overlays with the script', async () => {
    const { supabase, db } = createMockSupabase({ videos: [{ id: 'v-ov', script_json: { beats: [{ text: 'a' }, { text: 'b' }] } }] });
    await addOverlay(supabase, 'v-ov', { kind: 'callout', beat: 1, offsetSec: 2, durationSec: 3, text: 'Gatun Locks', x: 0.3, y: 0.6 });
    let list = await addOverlay(supabase, 'v-ov', { kind: 'text', beat: 0, offsetSec: 0, durationSec: 2, text: 'PANAMA, 1914', x: 0.5, y: 0.2 });
    assert.deepEqual(list.map((o) => o.text), ['PANAMA, 1914', 'Gatun Locks'], 'in video order');
    assert.deepEqual(db.videos[0].script_json.beats, [{ text: 'a' }, { text: 'b' }]);
    await assert.rejects(addOverlay(supabase, 'v-ov', { kind: 'text', beat: 5, offsetSec: 0, text: 'x', x: 0.5, y: 0.5 }), /does not exist/);

    list = await updateOverlay(supabase, 'v-ov', list[1].id, { durationSec: 6 });
    assert.equal(list[1].durationSec, 6);
    list = await deleteOverlay(supabase, 'v-ov', list[0].id);
    assert.deepEqual((await listOverlays(supabase, 'v-ov')).map((o) => o.text), ['Gatun Locks']);
  });
});
