import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  accentExpression,
  accentTimes,
  buildMusicMomentsPrompt,
  ensureMusicMoments,
  normalizeMusicMoments,
} from '../../src/pipeline/assembly/music-accents.ts';
import { narrationHash } from '../../src/pipeline/assembly/sound-moments.ts';
import { applyBackgroundMusic } from '../../src/pipeline/assembly/bgm.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);
const beats = Array.from({ length: 30 }, (_, i) => ({ index: i, text: `Line ${i}.` }));

async function meanVolumeDb(file: string, fromSec: number, toSec: number): Promise<number> {
  const { stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-ss', String(fromSec), '-to', String(toSec), '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = stderr.match(/mean_volume: (-?[\d.]+|-inf) dB/);
  return !m || m[1] === '-inf' ? -200 : Number(m[1]);
}

describe('Music that hits moments', () => {
  it('asks for a few real peaks only', () => {
    const prompt = buildMusicMomentsPrompt(beats);
    assert.match(prompt, /reveals: .*At most 3/);
    assert.match(prompt, /key_lines: .*At most 2/);
  });

  it('keeps real beats, once each, a key line never also a reveal, within the caps', () => {
    assert.deepEqual(normalizeMusicMoments({ reveals: [5, 5, 12, 40, 20, 25, 28], key_lines: [12, 3, 9, 99] }, beats), {
      reveals: [5, 20, 25],
      key_lines: [3, 9],
    });
  });

  it('times silences from the voice and keeps swells clear of chapter changes and silences', () => {
    const voices = {
      3: { startMs: 30_000, endMs: 34_000 },
      9: { startMs: 90_000, endMs: 120_000 },
      5: { startMs: 50_000, endMs: 55_000 },
      20: { startMs: 200_000, endMs: 205_000 },
      25: { startMs: 92_000, endMs: 95_000 },
    };
    const a = accentTimes({ reveals: [5, 20, 25], key_lines: [3, 9] }, voices, [198_000, 300_000]);
    assert.deepEqual(a.drops, [
      { startSec: 29.2, endSec: 34 },
      { startSec: 89.2, endSec: 97.2 },
    ], 'silence starts 0.8 s before the line and lasts at most 8 s');
    assert.deepEqual(a.swellsSec, [49.7], 'beat 20 is next to a chapter change; beat 25 is inside a silence');
    assert.deepEqual(a.stingsSec, [198, 300]);
  });

  it('builds a neutral expression when nothing is planned', () => {
    assert.equal(accentExpression({ swellsSec: [], drops: [] }), '1');
    const expr = accentExpression({ swellsSec: [10], drops: [{ startSec: 20, endSec: 24 }] });
    assert.match(expr, /^\(1\+0\.5\*/);
    assert.match(expr, /\(1-max\(0,min\(1,\(t-19\.600\)\/0\.4\)\)\*max\(0,min\(1,\(25\.500-t\)\/1\.5\)\)\)/);
  });

  it('really silences the music for a key line and plays the sting', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accents-'));
    try {
      const program = path.join(dir, 'program.mp4');
      const music = path.join(dir, 'music.wav');
      const sting = path.join(dir, 'sting.wav');
      // A silent "voice" so the output is the music alone
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', program]);
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=12', music]);
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=880:r=48000:d=0.5', sting]);
      const out = path.join(dir, 'out.mp4');
      await applyBackgroundMusic({
        videoPath: program,
        bgmPath: music,
        outputPath: out,
        volume: 0.3,
        accentExpression: accentExpression({ swellsSec: [], drops: [{ startSec: 5, endSec: 7 }] }),
        sting: { path: sting, atSec: [9] },
      });
      const during = await meanVolumeDb(out, 5.1, 6.9);
      const before = await meanVolumeDb(out, 2, 4);
      assert.ok(during < before - 40, `music gone during the silence (${during} dB vs ${before} dB)`);
      const withSting = await meanVolumeDb(out, 9, 9.4);
      assert.ok(withSting > before, `the sting lifts the level (${withSting} dB vs ${before} dB)`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('plans once per narration and reuses the saved plan', async () => {
    let calls = 0;
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock-music-moments',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => {
        calls++;
        return { data: { reveals: [4], key_lines: [8] }, usage: {} } as never;
      },
    };
    registerProvider('llm', 'mock-music-moments', llm);
    const { supabase, db } = createMockSupabase({
      videos: [{ id: 'v1', script_json: {} }],
      yt_provider_configs: [{ id: 'cfg-mm', kind: 'llm', provider: 'mock-music-moments', label: 'm', is_active: true }],
      yt_stage_bindings: [{ stage: 'script', provider_config_id: 'cfg-mm', max_retries: 0 }],
    });
    const plan = await ensureMusicMoments(supabase, 'v1', beats);
    assert.deepEqual([plan.reveals, plan.key_lines], [[4], [8]]);
    assert.equal(plan.textHash, narrationHash(beats));
    await ensureMusicMoments(supabase, 'v1', beats);
    assert.equal(calls, 1);
    assert.ok((db.videos[0] as { script_json: { music_moments?: unknown } }).script_json.music_moments);
  });
});
