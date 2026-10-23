import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BED_SOUND_IDS, MOMENT_SOUND_IDS, REAL_SOUNDS } from '../../src/pipeline/assembly/real-sfx.ts';
import { bedCues, buildMomentsPrompt, maxBeds, normalizeBeds, normalizeMoments, PLAN_VERSION, narrationHash } from '../../src/pipeline/assembly/sound-moments.ts';
import { applyPalette, paletteFor } from '../../src/pipeline/assembly/palettes.ts';
import { applySoundDesign } from '../../src/pipeline/assembly/sound-design.ts';
import { narrationSoundCues } from '../../src/pipeline/assembly/narration-sounds.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);
const beats = Array.from({ length: 10 }, (_, i) => ({ index: i, text: `Beat ${i} at the stadium as the crowd waits.` }));

describe('Ambience beds', () => {
  it('keeps one-shots, palette sounds and beds apart', () => {
    assert.ok(MOMENT_SOUND_IDS.includes('gunshot'));
    assert.ok(!MOMENT_SOUND_IDS.includes('stadium_bed' as never));
    assert.ok(!MOMENT_SOUND_IDS.includes('whoosh_soft' as never));
    assert.ok(BED_SOUND_IDS.includes('stadium_bed'));
    const prompt = buildMomentsPrompt(beats);
    assert.match(prompt, /- stadium_bed: Stadium crowd ambience/);
    assert.doesNotMatch(prompt, /whoosh_soft/);
    assert.equal(maxBeds(beats), 1);
  });

  it('keeps beds over real beats, at least two beats long, without overlaps, within the cap', () => {
    const twenty = Array.from({ length: 24 }, (_, i) => ({ index: i, text: 'x' }));
    const beds = normalizeBeds(
      [
        { start_beat: 10, end_beat: 14, sound: 'Rain_Bed' },
        { start_beat: 2, end_beat: 6, sound: 'stadium_bed' },
        { start_beat: 5, end_beat: 8, sound: 'city_bed' },
        { start_beat: 16, end_beat: 16, sound: 'wind_bed' },
        { start_beat: 18, end_beat: 20, sound: 'gunshot' },
        { start_beat: 30, end_beat: 33, sound: 'rain_bed' },
      ],
      twenty,
    );
    assert.deepEqual(beds, [
      { start_beat: 2, end_beat: 6, sound: 'stadium_bed' },
      { start_beat: 10, end_beat: 14, sound: 'rain_bed' },
    ]);
    // A bed id is never a one-shot moment
    assert.deepEqual(normalizeMoments([{ beat_index: 1, trigger: 'stadium', sound: 'stadium_bed' }], beats), []);
  });

  it('spans a bed from its first scene to its last, skipping beds without a recording', () => {
    const cues = bedCues(
      [
        { start_beat: 2, end_beat: 4, sound: 'stadium_bed' },
        { start_beat: 6, end_beat: 7, sound: 'rain_bed' },
      ],
      { 2: { startMs: 10_000, endMs: 15_000 }, 4: { startMs: 20_000, endMs: 26_000 }, 6: { startMs: 30_000, endMs: 34_000 }, 7: { startMs: 34_000, endMs: 38_000 } },
      { stadium_bed: '/sfx/stadium.wav' },
    );
    assert.deepEqual(cues, [{ startMs: 10_000, endMs: 26_000, file: '/sfx/stadium.wav', gain: REAL_SOUNDS.stadium_bed.gain, fadeMs: 1500 }]);
  });

  it('mixes a looped bed under its stretch without changing the length', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bed-'));
    try {
      const program = path.join(dir, 'program.mp4');
      const bed = path.join(dir, 'bed.wav');
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30', '-f', 'lavfi', '-i', 'sine=f=300:r=48000,volume=0.3', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', program]);
      // A 1.5 s recording looped over a 4 s stretch
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=1.5:c=pink:r=48000', '-ac', '1', bed]);
      const out = path.join(dir, 'out.mp4');
      const result = await applySoundDesign({ videoPath: program, outputPath: out, cues: [], beds: [{ startMs: 1000, endMs: 5000, file: bed, gain: 0.5, fadeMs: 1500 }] });
      assert.equal(result.cueCount, 1);
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
      assert.ok(Math.abs(Number(stdout.trim()) - 6) < 0.15, `length kept, got ${stdout.trim()}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('plans again when a saved plan predates beds', async () => {
    let calls = 0;
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock-beds-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => {
        calls++;
        return { data: { moments: [], beds: [{ start_beat: 0, end_beat: 3, sound: 'stadium_bed' }] }, usage: {} } as never;
      },
    };
    registerProvider('llm', 'mock-beds-llm', llm);
    const scenes = beats.map((b, i) => ({ ...b, voiceStartMs: i * 5000 + 300, sceneStartMs: i * 5000, sceneEndMs: (i + 1) * 5000 }));
    const { supabase, db } = createMockSupabase({
      videos: [{ id: 'v1', script_json: { sound_moments: { textHash: narrationHash(beats), plannedAt: '', moments: [] } } }],
      yt_provider_configs: [{ id: 'cfg-beds', kind: 'llm', provider: 'mock-beds-llm', label: 'b', is_active: true }],
      yt_stage_bindings: [{ stage: 'script', provider_config_id: 'cfg-beds', max_retries: 0 }],
    });
    await narrationSoundCues({ supabase, videoId: 'v1', style: 'sport', beats: scenes });
    assert.equal(calls, 1, 'an old plan without beds is made again');
    const saved = (db.videos[0] as { script_json: { sound_moments: { version: number; beds: unknown[] } } }).script_json.sound_moments;
    assert.equal(saved.version, PLAN_VERSION);
    assert.equal(saved.beds.length, 1);
    await narrationSoundCues({ supabase, videoId: 'v1', style: 'sport', beats: scenes });
    assert.equal(calls, 1, 'the new plan is reused');
  });
});

describe('Style palettes', () => {
  it('gives each style its own recordings, and none for unknown styles', () => {
    assert.equal(paletteFor('history').key, 'typewriter_key');
    assert.equal(paletteFor('sport').chime, 'whistle');
    assert.equal(paletteFor('tech').tick, 'ui_click');
    assert.deepEqual(paletteFor('nonsense'), {});
    for (const palette of ['history', 'sport', 'tech', 'mystery', 'finance'].map(paletteFor)) {
      for (const real of Object.values(palette)) assert.ok(real! in REAL_SOUNDS, `${real} is in the catalog`);
    }
  });

  it('swaps on-screen effects for available recordings and keeps the rest synthesised', async () => {
    const prepared: string[] = [];
    const prepare = async (id: string) => {
      prepared.push(id);
      return id === 'typewriter_key' ? `/real/${id}.wav` : null;
    };
    const cues = await applyPalette(
      [
        { atMs: 100, sound: 'key', gain: 0.4 },
        { atMs: 200, sound: 'key', gain: 0.4 },
        { atMs: 300, sound: 'whoosh', gain: 0.5 },
        { atMs: 400, sound: 'real:gunshot', file: '/real/gunshot.wav', gain: 1.6 },
      ],
      'history',
      prepare as never,
    );
    assert.deepEqual(cues.map((c) => c.file ?? c.sound), ['/real/typewriter_key.wav', '/real/typewriter_key.wav', 'whoosh', '/real/gunshot.wav']);
    assert.equal(cues[0].sound, 'real:typewriter_key');
    assert.deepEqual(prepared.sort(), ['typewriter_key', 'whoosh_soft'], 'each recording prepared once');
  });
});
