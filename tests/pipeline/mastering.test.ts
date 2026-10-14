import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isPassThroughVideo, renderBeatScene } from '../../src/pipeline/assembly/assemble-beat.ts';
import { applyBackgroundMusic } from '../../src/pipeline/assembly/bgm.ts';
import { masterFinalVideo, measureLoudness, TARGET_LUFS } from '../../src/pipeline/assembly/master.ts';
import { renderMotionClip, motionDocument } from '../../src/pipeline/visuals/motion/frame-renderer.ts';

const execFileAsync = promisify(execFile);
const ff = (...args: string[]) => execFileAsync('ffmpeg', ['-y', '-v', 'error', ...args]);
const lufs = async (file: string) => Number.parseFloat((await measureLoudness(file)).input_i);

async function probe(file: string, entries: string): Promise<string> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', file]);
  return stdout.trim().replace(/,+$/, '');
}

describe('Mixing and mastering', () => {
  let dir: string;
  let track: string;
  let voice: string;
  let sfx: string;
  let silence: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'master-'));
    track = path.join(dir, 'track.mp4');
    voice = path.join(dir, 'voice.wav');
    sfx = path.join(dir, 'sfx.wav');
    silence = path.join(dir, 'silence.wav');
    // A finished 1080p30 track, like a beat composed from shots
    await ff('-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', track);
    // A quiet "voice": speech-band tone bursts around -26 LUFS, like raw local TTS
    await ff('-f', 'lavfi', '-i', "sine=f=300:r=48000,volume='0.06*gt(mod(t,0.5),0.1)':eval=frame", '-t', '3', voice);
    await ff('-f', 'lavfi', '-i', 'anoisesrc=d=0.3:c=white:r=48000,volume=0.3', sfx);
    await ff('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '3', silence);
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('copies a finished track instead of re-encoding it', async () => {
    assert.equal(await isPassThroughVideo(track, 2.9), true);
    assert.equal(await isPassThroughVideo(track, 5), false, 'too short to cover the beat');
    const out = path.join(dir, 'scene_copy.mp4');
    await renderBeatScene({ visualPath: track, audioPath: voice, durationMs: 2900, outputPath: out, isVideo: true });
    assert.equal(await probe(out, 'stream=width,height,pix_fmt'), '1920,1080,yuv420p');
  });

  it('keeps the voice at full level when a sound effect is added', async () => {
    const without = path.join(dir, 'scene_voice.mp4');
    const withSfx = path.join(dir, 'scene_sfx.mp4');
    await renderBeatScene({ visualPath: track, audioPath: voice, durationMs: 3000, outputPath: without, isVideo: true });
    await renderBeatScene({ visualPath: track, audioPath: voice, durationMs: 3000, outputPath: withSfx, isVideo: true, sfxPath: sfx, sfxVolume: 0.02 });
    // A barely audible effect must not pull the voice down (the old mix halved it: -6 dB)
    assert.ok(Math.abs((await lufs(withSfx)) - (await lufs(without))) < 1, 'voice level unchanged by the effect');
  });

  it('keeps the voice at full level under music', async () => {
    const scene = path.join(dir, 'scene_for_music.mp4');
    const mixed = path.join(dir, 'with_music.mp4');
    await renderBeatScene({ visualPath: track, audioPath: voice, durationMs: 3000, outputPath: scene, isVideo: true });
    await applyBackgroundMusic({ videoPath: scene, bgmPath: silence, outputPath: mixed, volume: 0.2 });
    assert.ok(Math.abs((await lufs(mixed)) - (await lufs(scene))) < 1, 'silent music leaves the voice where it was');
  });

  it('masters the programme to YouTube loudness, burning captions in one encode', async () => {
    const scene = path.join(dir, 'scene_master.mp4');
    await renderBeatScene({ visualPath: track, audioPath: voice, durationMs: 3000, outputPath: scene, isVideo: true });
    const ass = path.join(dir, 'captions.ass');
    await fs.writeFile(
      ass,
      '[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default, Segoe UI, 60, &H00FFFFFF, &H00FFFFFF, &H00000000, &H00000000, 1, 0, 0, 0, 100, 100, 0, 0, 1, 2, 0, 2, 80, 80, 80, 1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,Hello\n',
    );
    const final = path.join(dir, 'final.mp4');
    const { measured } = await masterFinalVideo({ inputPath: scene, outputPath: final, assPath: ass });
    assert.ok(Number.parseFloat(measured.input_i) < -18, 'the raw programme was quiet');
    assert.ok(Math.abs((await lufs(final)) - TARGET_LUFS) < 1, 'mastered to about -14 LUFS');
    assert.equal(await probe(final, 'stream=width,height'), '1920,1080');
  });

  it('encodes motion graphics in TV range, matching footage', async () => {
    const out = path.join(dir, 'motion.mp4');
    await renderMotionClip({
      html: motionDocument({ css: 'body{background:#f4efe4}', body: '', script: 'window.__frame=()=>{}' }),
      durationSec: 0.2,
      outputPath: out,
    });
    assert.equal(await probe(out, 'stream=pix_fmt,color_range'), 'yuv420p,tv');
  });
});
