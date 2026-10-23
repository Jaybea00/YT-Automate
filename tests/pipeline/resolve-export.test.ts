import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { chromium } from 'playwright';
import { buildFcpxml, prepareResolveExport, resolveExportDir, writeResolveZip } from '../../src/pipeline/publish/resolve-export.ts';
import { applyBackgroundMusic } from '../../src/pipeline/assembly/bgm.ts';
import { applySoundDesign } from '../../src/pipeline/assembly/sound-design.ts';
import { probeClipDurationSec } from '../../src/pipeline/assembly/assemble-beat.ts';
import { rendersDir } from '../../src/pipeline/publish/publish-assets.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);

async function makeClip(file: string, sec: number, withAudio = true) {
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30',
    ...(withAudio ? ['-f', 'lavfi', '-i', 'sine=f=300:r=48000'] : []),
    '-t', String(sec), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(withAudio ? ['-c:a', 'aac', '-shortest'] : []), file,
  ]);
}

/** Parses the XML in a real browser, so a malformed timeline fails the test. */
async function parseXml(text: string): Promise<{ error: string | null; clips: number; lanes: string[] }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await page.evaluate((src) => {
      const doc = new DOMParser().parseFromString(src, 'application/xml');
      const err = doc.querySelector('parsererror');
      const clips = Array.from(doc.querySelectorAll('asset-clip'));
      return { error: err ? err.textContent : null, clips: clips.length, lanes: clips.map((c) => c.getAttribute('lane') ?? '') };
    }, text);
  } finally {
    await browser.close();
  }
}

describe('DaVinci Resolve export', () => {
  it('builds a well-formed timeline: picture on alternating lanes, narration, music and effects below', async () => {
    const xml = buildFcpxml('The "Crash" & after', {
      scenes: [
        { path: 'C:\\x\\scene_001.mp4', startSec: 0, durationSec: 4, beat: 0 },
        { path: 'C:\\x\\scene_002.mp4', startSec: 3.5, durationSec: 5, beat: 1 },
      ],
      voices: [{ path: 'C:\\x\\voice_001.mp3', startSec: 0.2, durationSec: 3.4, beat: 0 }],
      music: { path: 'C:\\x\\music.m4a', durationSec: 9 },
      sfx: { path: 'C:\\x\\sfx.m4a', durationSec: 8.5 },
      totalSec: 8.5,
    });
    const parsed = await parseXml(xml);
    assert.equal(parsed.error, null);
    assert.equal(parsed.clips, 5);
    assert.deepEqual(parsed.lanes, ['1', '2', '-1', '-2', '-3']);
    assert.match(xml, /offset="105\/30s"/, 'the second scene overlaps the first, as in the video');
    assert.match(xml, /src="file:\/\/\/C:\/x\/scene_001\.mp4"/);
    assert.match(xml, /The &quot;Crash&quot; &amp; after/);
    assert.match(xml, /<asset-clip ref="a4" lane="-2" offset="0s" name="music" start="0s" duration="255\/30s" audioRole="music"\/>/, 'music cut to the video length');
  });

  it('saves the ducked music and the effects on their own, at the programme length', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stems-'));
    try {
      const program = path.join(dir, 'program.mp4');
      const music = path.join(dir, 'music.wav');
      await makeClip(program, 5);
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=2', music]);
      const musicStem = path.join(dir, 'music_stem.m4a');
      await applyBackgroundMusic({ videoPath: program, bgmPath: music, outputPath: path.join(dir, 'with_music.mp4'), volume: 0.3, stemPath: musicStem });
      assert.ok(Math.abs((await probeClipDurationSec(musicStem)) - 5) < 0.2, 'the looping music stem stops with the video');

      const sfxStem = path.join(dir, 'sfx_stem.m4a');
      const withSfx = path.join(dir, 'with_sfx.mp4');
      await applySoundDesign({ videoPath: program, outputPath: withSfx, cues: [{ atMs: 1000, sound: 'tick', gain: 0.6 }], stemPath: sfxStem });
      assert.ok(Math.abs((await probeClipDurationSec(sfxStem)) - 5) < 0.2);
      assert.ok(Math.abs((await probeClipDurationSec(withSfx)) - 5) < 0.2, 'the programme is unchanged in length');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('prepares a folder with picture-only scenes, narration, stems, captions and a README, and zips it', async () => {
    const videoId = `test-resolve-${Date.now()}`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-src-'));
    try {
      const scene1 = path.join(dir, 'scene_0.mp4');
      const scene2 = path.join(dir, 'scene_1.mp4');
      const voice = path.join(dir, 'voice_0.mp3');
      const musicStem = path.join(dir, 'music.m4a');
      await makeClip(scene1, 2);
      await makeClip(scene2, 2);
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=200:r=48000:d=1.5', voice]);
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=100:r=48000:d=4', '-c:a', 'aac', musicStem]);
      const { supabase } = createMockSupabase();
      const video = {
        id: videoId,
        title: 'Test',
        script_json: {
          beats: [{ index: 0, text: 'One two three.' }, { index: 1, text: 'Four five six.' }],
          timeline: {
            version: 1,
            renderedAt: '',
            totalMs: 4000,
            beats: [
              { index: 0, sceneStartMs: 0, sceneMs: 2000, voiceStartMs: 200, voiceMs: 1500, audioPath: voice, trackPath: null, sceneClipPath: scene1 },
              { index: 1, sceneStartMs: 2000, sceneMs: 2000, voiceStartMs: 2200, voiceMs: null, audioPath: null, trackPath: null, sceneClipPath: scene2 },
            ],
            stems: { music: musicStem, sfx: null },
          },
        },
      };
      const out = await prepareResolveExport(supabase, video);
      assert.equal(out, resolveExportDir(videoId));
      const files = (await fs.readdir(path.join(out, 'media'))).sort();
      assert.deepEqual(files, ['music.m4a', 'scene_001.mp4', 'scene_002.mp4', 'voice_001.mp3']);
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path.join(out, 'media', 'scene_001.mp4')]);
      assert.equal(stdout.trim(), '', 'scene copies are picture only: the narration has its own track');
      const timeline = await fs.readFile(path.join(out, 'timeline.fcpxml'), 'utf-8');
      assert.equal((await parseXml(timeline)).error, null);
      assert.ok(await fs.stat(path.join(out, 'README.txt')));

      const zip = new PassThrough();
      const chunks: Buffer[] = [];
      zip.on('data', (c) => chunks.push(c));
      await writeResolveZip(out, zip);
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.subarray(0, 2).toString(), 'PK');
      assert.ok(bytes.includes(Buffer.from('media/scene_001.mp4')));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(rendersDir(videoId), { recursive: true, force: true });
    }
  });

  it('asks for a render first when there is no finished edit', async () => {
    const { supabase } = createMockSupabase();
    await assert.rejects(prepareResolveExport(supabase, { id: 'x', script_json: {} }), /Render the video first/);
  });
});
