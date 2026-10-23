import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildEmphasisPrompt,
  emphasisGraph,
  freezeWindows,
  letterboxFilter,
  LETTERBOX_PX,
  maxFreezes,
  normalizeFreezes,
  prepareEmphasis,
  renderFreezeTitles,
} from '../../src/pipeline/assembly/emphasis.ts';
import { masterFinalVideo } from '../../src/pipeline/assembly/master.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { STYLE_PACKS } from '../../src/lib/styles/packs.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);
const beats = Array.from({ length: 40 }, (_, i) => ({ index: i, text: `Line ${i}.` }));

/** How alike two moments of a video are (PSNR, dB): identical frames come out above ~50 after encoding. */
async function similarityDb(file: string, a: number, b: number, dir: string): Promise<number> {
  const pa = path.join(dir, 'a.png');
  const pb = path.join(dir, 'b.png');
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-ss', String(a), '-i', file, '-frames:v', '1', pa]);
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-ss', String(b), '-i', file, '-frames:v', '1', pb]);
  const { stderr } = await execFileAsync('ffmpeg', ['-i', pa, '-i', pb, '-lavfi', 'psnr', '-f', 'null', '-']);
  const m = stderr.match(/average:(inf|[\d.]+)/);
  return !m || m[1] === 'inf' ? 100 : Number(m[1]);
}

describe('Emphasis effects', () => {
  it('asks for a few freeze-frames with short factual titles', () => {
    const prompt = buildEmphasisPrompt(beats);
    assert.match(prompt, /at most 2/);
    assert.match(prompt, /"28 JUNE 1914"/);
    assert.equal(maxFreezes(Array.from({ length: 200 }, (_, i) => ({ index: i, text: 'x' }))), 3);
  });

  it('keeps freezes on real beats, once each, with short upper-case titles', () => {
    assert.deepEqual(
      normalizeFreezes(
        [
          { beat_index: 9, title: '"Gavrilo Princip, 19"' },
          { beat_index: 3, title: '28 June 1914' },
          { beat_index: 3, title: 'again' },
          { beat_index: 99, title: 'nowhere' },
          { beat_index: 12, title: 'a title that is far too long to read' },
        ],
        beats,
      ),
      [
        { beat_index: 3, title: '28 JUNE 1914' },
        { beat_index: 9, title: 'GAVRILO PRINCIP, 19' },
      ],
    );
  });

  it('holds a freeze for up to 2.5 s of the line, never overlapping the next', () => {
    const w = freezeWindows(
      [
        { beat_index: 1, title: 'A' },
        { beat_index: 2, title: 'B' },
        { beat_index: 5, title: 'C' },
      ],
      { 1: { startMs: 10_000, endMs: 20_000 }, 2: { startMs: 12_000, endMs: 14_000 }, 5: { startMs: 30_000, endMs: 30_500 } },
    );
    assert.deepEqual(w.map((x) => [x.title, x.atSec, x.durSec]), [
      ['A', 10, 2.5],
      ['C', 30, 1.2],
    ]);
  });

  it('builds one overlay per effect, and nothing when there are none', () => {
    assert.equal(emphasisGraph({ shakes: [], zooms: [], freezes: [] }, 1), '[vin]null[vfx]');
    const g = emphasisGraph({ shakes: [{ atSec: 4 }], zooms: [{ atSec: 8 }], freezes: [{ atSec: 12, durSec: 2, titlePng: 'x.png' }] }, 1);
    assert.match(g, /^\[vin\]split=4\[m0\]\[w0\]\[w1\]\[w2\]/);
    assert.match(g, /crop=w=iw-28:h=ih-28/);
    assert.match(g, /zoompan=z=/);
    assert.match(g, /loop=loop=59:size=1/);
    assert.match(g, /\[f2\]\[1:v\]overlay=shortest=1/);
    assert.match(g, /\[m2\]\[o2\]overlay=eof_action=pass:enable='between\(t,12\.000,14\.000\)'\[vfx\]$/);
    assert.equal(letterboxFilter(0), null);
    assert.match(letterboxFilter(LETTERBOX_PX)!, /drawbox=x=0:y=ih-60:w=iw:h=60/);
  });

  it('suits each style: letterbox for cinematic ones, chapter zooms for fast ones', () => {
    assert.equal(STYLE_PACKS.cinematic.emphasis?.letterbox, true);
    assert.equal(STYLE_PACKS.mystery.emphasis?.letterbox, true);
    assert.equal(STYLE_PACKS.sport.emphasis?.chapterZoom, true);
    assert.equal((STYLE_PACKS.history as { emphasis?: unknown }).emphasis, undefined);
  });

  it('shakes on impact sounds only, zooms by style, and can be switched off', async () => {
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock-emphasis-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => ({ data: { freezes: [] }, usage: {} }) as never,
    };
    registerProvider('llm', 'mock-emphasis-llm', llm);
    const { supabase } = createMockSupabase({
      videos: [{ id: 'v1', script_json: {} }],
      yt_provider_configs: [{ id: 'cfg-em', kind: 'llm', provider: 'mock-emphasis-llm', label: 'e', is_active: true }],
      yt_stage_bindings: [{ stage: 'script', provider_config_id: 'cfg-em', max_retries: 0 }],
    });
    const common = {
      supabase,
      videoId: 'v1',
      theme: themeForStyle('sport'),
      beats: beats.slice(0, 5).map((b, i) => ({ ...b, voiceStartMs: i * 5000, voiceEndMs: i * 5000 + 4000 })),
      soundCues: [
        { atMs: 3000, sound: 'real:gunshot' },
        { atMs: 6000, sound: 'real:whistle' },
      ],
      chapterChangesMs: [10_000],
      tempDir: os.tmpdir(),
    };
    const sport = await prepareEmphasis({ ...common, style: 'sport' });
    assert.equal(sport?.summary, '1 shake(s), 0 freeze-frame(s), 1 chapter zoom(s)');
    const cinematic = await prepareEmphasis({ ...common, style: 'cinematic' });
    assert.equal(cinematic?.summary, '1 shake(s), 0 freeze-frame(s), 0 chapter zoom(s), letterbox');
    const noBars = await prepareEmphasis({ ...common, style: 'cinematic', settings: { letterbox: false } });
    assert.equal(noBars?.letterbox, null);
    assert.equal(await prepareEmphasis({ ...common, style: 'sport', settings: { enabled: false } }), null);
  });

  it('renders a transparent freeze title in the style', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freeze-title-'));
    try {
      const [png] = await renderFreezeTitles(themeForStyle('history'), ['28 JUNE 1914'], dir);
      assert.ok((await fs.stat(png)).size > 1000);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('really freezes, shakes and zooms in the master, keeping the length', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emphasis-'));
    try {
      const program = path.join(dir, 'program.mp4');
      const title = path.join(dir, 'title.png');
      // Moving picture, so a frozen stretch is detectable
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30', '-f', 'lavfi', '-i', 'sine=f=300:r=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', program]);
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white@0.0:s=1920x1080,format=rgba,drawbox=x=100:y=800:w=600:h=80:color=red:t=fill', '-frames:v', '1', title]);
      const out = path.join(dir, 'out.mp4');
      const windows = { shakes: [{ atSec: 1 }], zooms: [{ atSec: 2.2 }], freezes: [{ atSec: 4, durSec: 2, titlePng: title }] };
      await masterFinalVideo({
        inputPath: program,
        outputPath: out,
        emphasis: { graph: emphasisGraph(windows, 1), inputs: ['-loop', '1', '-i', title], letterbox: letterboxFilter(LETTERBOX_PX) },
      });
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
      assert.ok(Math.abs(Number(stdout.trim()) - 8) < 0.2, `length kept, got ${stdout.trim()}`);
      const frozen = await similarityDb(out, 4.6, 5.6, dir);
      const moving = await similarityDb(out, 6.5, 7.2, dir);
      assert.ok(frozen > 45, `frozen during the freeze (${frozen} dB)`);
      assert.ok(moving < 30, `moving again after it (${moving} dB)`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
