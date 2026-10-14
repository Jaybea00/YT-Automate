import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applySoundDesign, planSoundCues, shotCues, thinCues } from '../../src/pipeline/assembly/sound-design.ts';
import { ensureSoundLibrary, resolveSfxPath, SOUND_IDS, soundPath } from '../../src/pipeline/assembly/sfx.ts';
import { measureLoudness } from '../../src/pipeline/assembly/master.ts';
import type { ShotPlan } from '../../src/lib/script/generate-script.ts';

const execFileAsync = promisify(execFile);
const plan = (extra: Partial<ShotPlan>): ShotPlan => ({ visual_type: 'stock', visual_query: 'q', covers: 'c', word_start: 0, word_count: 5, ...extra });
const sounds = (cues: Array<{ sound: string }>) => cues.map((c) => c.sound);

describe('Smart sound cues', () => {
  it('lands an impact when a stat finishes counting', () => {
    const cues = shotCues({ renderedType: 'stat', durationSec: 4, plan: plan({ visual_type: 'stat' }) });
    const impact = cues.find((c) => c.sound === 'impact')!;
    assert.ok(Math.abs(impact.at - (0.1 + 1.6)) < 1e-9, 'stat counts for min(1.6 s, 45%) from 0.1 s');
  });

  it('ticks each bar as it lands, each timeline event, and pings each map pin', () => {
    const bars = shotCues({ renderedType: 'chart', durationSec: 5, plan: plan({ chart: { chart_type: 'bar', title: 't', labels: ['a', 'b', 'c'], values: [1, 2, 3] } }) });
    assert.deepEqual(sounds(bars), ['tick', 'tick', 'tick']);
    assert.ok(Math.abs(bars[1].at - bars[0].at - 0.18) < 1e-9, 'bars start 0.18 s apart');

    const timeline = shotCues({ renderedType: 'timeline', durationSec: 6, plan: plan({ timeline: { events: [1, 2, 3, 4].map((i) => ({ date: `${i}`, label: 'x' })) } }) });
    assert.equal(sounds(timeline).filter((s) => s === 'tick').length, 4);

    const route = shotCues({ renderedType: 'geo_map', durationSec: 5, plan: plan({ map: { places: ['London', 'Paris', 'Berlin'], mode: 'route' } }) });
    assert.deepEqual(sounds(route), ['swoosh', 'ping', 'ping', 'ping'], 'origin pin plus one per arc');
  });

  it('keeps footage clean except for a name caption sliding in', () => {
    assert.deepEqual(shotCues({ renderedType: 'archive', durationSec: 4, plan: plan({}) }), []);
    assert.deepEqual(sounds(shotCues({ renderedType: 'archive', durationSec: 4, note: 'relevance 9/10; caption: Hoover', plan: plan({}) })), ['whoosh']);
  });

  it('rings in chapter titles and rustles newspapers, even for beats without saved plans', () => {
    assert.deepEqual(sounds(shotCues({ renderedType: 'title', durationSec: 3 })), ['riser', 'chime']);
    assert.deepEqual(sounds(shotCues({ renderedType: 'newspaper', durationSec: 3 })), ['paper']);
  });

  it('drops too-close repeats and cues before the start', () => {
    const thinned = thinCues([
      { atMs: -200, sound: 'riser', gain: 1 },
      { atMs: 1000, sound: 'tick', gain: 1 },
      { atMs: 1050, sound: 'tick', gain: 1 },
      { atMs: 1060, sound: 'ping', gain: 1 },
    ]);
    assert.deepEqual(thinned.map((c) => `${c.atMs}${c.sound}`), ['1000tick', '1060ping']);
  });
});

describe('Laying the effects', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sound-design-'));
    await ensureSoundLibrary();
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('builds a peak-normalised library, and "smart" replaces the per-beat effect', async () => {
    for (const id of SOUND_IDS) {
      const { stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-i', soundPath(id), '-af', 'volumedetect', '-f', 'null', '-']);
      assert.match(stderr, /max_volume: -3\.0 dB/, `${id} peaks at -3 dB`);
    }
    assert.equal(await resolveSfxPath('smart'), null);
  });

  it('places cues from composed beats and keeps them under the voice', async () => {
    const track = path.join(dir, 'visuals_beat_0.mp4');
    await fs.writeFile(
      `${track}.shots.json`,
      JSON.stringify({ beatIndex: 0, shots: [{ renderedType: 'stat', startSec: 0.5, durationSec: 3, plan: plan({ visual_type: 'stat' }) }] }),
    );
    const cues = await planSoundCues([
      { sceneStartMs: 0, trackPath: null, opensSection: false },
      { sceneStartMs: 2000, trackPath: track, opensSection: true },
    ]);
    assert.deepEqual(cues.map((c) => `${c.atMs}${c.sound}`), ['1700swoosh', '2500whoosh', '3950impact']);

    // A steady "voice" with the cues laid over it
    const program = path.join(dir, 'program.mp4');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30', '-f', 'lavfi', '-i', 'sine=f=300:r=48000,volume=0.3', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', program]);
    const out = path.join(dir, 'with_sfx.mp4');
    const result = await applySoundDesign({ videoPath: program, outputPath: out, cues });
    assert.equal(result.cueCount, 3);
    const before = Number.parseFloat((await measureLoudness(program)).input_i);
    const after = Number.parseFloat((await measureLoudness(out)).input_i);
    assert.ok(after - before < 1.5, `effects barely move the overall level (${before} -> ${after})`);
  });
});
