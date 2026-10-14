import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isLandingLine, planPacing } from '../../src/pipeline/assembly/pacing.ts';
import { evenSections, normalizeSections, planSectionsWithLlm, scriptSignature, sectionsFromTitleCards } from '../../src/pipeline/assembly/sections.ts';
import { renderBeatScene } from '../../src/pipeline/assembly/assemble-beat.ts';
import { composeBeatTrack, padTimeline } from '../../src/pipeline/visuals/shot-composer.ts';
import { makeColorClip } from '../../src/pipeline/visuals/clips.ts';
import { generateYouTubeChapters } from '../../src/pipeline/utils/chapters.ts';
import type { ScriptBeat, ShotPlan } from '../../src/lib/script/generate-script.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';

const execFileAsync = promisify(execFile);
const line = (words: number, end = '.') => `${Array.from({ length: words }, (_, i) => `w${i}`).join(' ')}${end}`;

describe('Pacing between beats', () => {
  const beats = [
    { index: 0, text: line(20) },
    { index: 1, text: line(20, '?') },
    { index: 2, text: line(20) },
    { index: 3, text: line(20) },
    { index: 4, text: line(5) },
  ];
  const sections = [{ start_beat: 0, title: 'Opening' }, { start_beat: 3, title: 'Fallout' }];

  it('leads every cut with the picture and lets questions, punches and endings land', () => {
    const p = planPacing(beats, sections, 0.5);
    assert.equal(p.get(0)!.leadInSec, 0.2, 'picture before voice');
    const flowing = p.get(0)!.tailSec + p.get(1)!.leadInSec;
    const landing = p.get(1)!.tailSec + p.get(2)!.leadInSec;
    assert.ok(Math.abs(flowing - 0.3) < 1e-9, `flowing gap ${flowing}`);
    assert.ok(landing > flowing, 'a question gets more room');
    assert.equal(p.get(4)!.tailSec, 1.2, 'the ending breathes');
    assert.ok(isLandingLine('Then it broke.') && !isLandingLine(line(20)));
  });

  it('gives a section change the longest gap, dipping to black inside it', () => {
    const p = planPacing(beats, sections, 0.5);
    assert.equal(p.get(2)!.dipOut, true);
    assert.equal(p.get(3)!.dipIn, true);
    assert.ok(p.get(2)!.tailSec + p.get(3)!.leadInSec >= 1.2);
    assert.equal(p.get(0)!.dipIn, false, 'the video does not open on a dip');
  });

  it('turns pauses off entirely when the setting is zero', () => {
    for (const v of planPacing(beats, sections, 0).values()) assert.deepEqual(v, { leadInSec: 0, tailSec: 0, dipIn: false, dipOut: false });
  });
});

describe('Sections', () => {
  const shot = (extra: Partial<ShotPlan> = {}): ShotPlan => ({ visual_type: 'stock', visual_query: 'q', covers: 'c', word_start: 0, word_count: 5, ...extra });
  const beat = (i: number, shots: ShotPlan[] = [shot()]): ScriptBeat => ({ index: i, text: `Beat ${i} text here.`, visual_type: 'stock', visual_query: 'q', duration_estimate_seconds: 5, shots });

  it('keeps sections usable: from beat 0, at least 4 beats long, last one with room', () => {
    const s = normalizeSections(
      [{ start_beat: 5, title: '"The Crash."' }, { start_beat: 7, title: 'Too close' }, { start_beat: 12, title: 'Recovery' }, { start_beat: 18, title: 'Too late' }],
      20,
    );
    assert.deepEqual(s, [{ start_beat: 0, title: 'Introduction' }, { start_beat: 5, title: 'The Crash' }, { start_beat: 12, title: 'Recovery' }]);
  });

  it('uses the director\'s chapter cards when the script has them', () => {
    const beats = Array.from({ length: 16 }, (_, i) => beat(i, i === 6 ? [shot({ visual_type: 'title', title_card: { text: 'The Fallout' } })] : [shot()]));
    assert.deepEqual(sectionsFromTitleCards(beats), [{ start_beat: 0, title: 'Introduction' }, { start_beat: 6, title: 'The Fallout' }]);
    assert.equal(sectionsFromTitleCards([beat(0), beat(1)]), null);
  });

  it('splits evenly as a last resort, and notices script edits', () => {
    const beats = Array.from({ length: 30 }, (_, i) => beat(i));
    assert.deepEqual(evenSections(beats).map((s) => s.start_beat), [0, 10, 20]);
    const edited = beats.map((b, i) => (i === 3 ? { ...b, text: 'Rewritten.' } : b));
    assert.notEqual(scriptSignature(beats), scriptSignature(edited));
  });

  it('asks the LLM for chapter titles and cleans its answer', async () => {
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => ({ data: { sections: [{ start_beat: 0, title: 'Black Tuesday' }, { start_beat: 9, title: 'Banks Fall.' }, { start_beat: 2, title: 'Too short' }] } as never, usage: {} }),
    };
    const s = await planSectionsWithLlm(Array.from({ length: 20 }, (_, i) => ({ text: `t${i}` })), '1929', llm, { apiKey: 'k' });
    assert.deepEqual(s, [{ start_beat: 0, title: 'Black Tuesday' }, { start_beat: 9, title: 'Banks Fall' }]);
  });
});

describe('YouTube chapters from sections', () => {
  const beats = Array.from({ length: 12 }, (_, i) => ({ index: i, text: `Beat ${i}.` }));
  const units = beats.map((b) => ({ unit_index: b.index, duration_ms: 6000 }));
  const sections = [{ start_beat: 0, title: 'Opening' }, { start_beat: 4, title: 'Middle' }, { start_beat: 8, title: 'End' }];

  it('times chapters where their sections really start, including the pauses', () => {
    const r = generateYouTubeChapters({ beats, units, sections, gapMs: Object.fromEntries(beats.map((b) => [b.index, 500])) });
    assert.deepEqual(r.chapters.map((c) => c.timestamp), ['00:00', '00:26', '00:52']);
    assert.equal(r.formattedText.split('\n').length, 3);

    const exact = generateYouTubeChapters({ beats, units, sections, beatStartMs: { 4: 30_000, 8: 61_000 }, customTitles: { 4: 'Custom' } });
    assert.deepEqual(exact.chapters.map((c) => [c.timestamp, c.title]), [['00:00', 'Opening'], ['00:30', 'Custom'], ['01:01', 'End']]);
  });

  it('follows YouTube\'s rules: 10-second chapters, at least three', () => {
    const short = generateYouTubeChapters({ beats, units, sections: [...sections, { start_beat: 9, title: 'Blink' }] });
    assert.ok(!short.chapters.some((c) => c.title === 'Blink'), 'a chapter under 10 s merges away');
    const two = generateYouTubeChapters({ beats, units, sections: sections.slice(0, 2) });
    assert.equal(two.formattedText, '', 'two chapters would be ignored by YouTube');
  });
});

describe('Paced rendering', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pacing-'));
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('builds the lead-in and tail into composed tracks, keeping cuts on their words', async () => {
    const padded = padTimeline([{ shot: {} as ShotPlan, startSec: 0, frames: 30 }, { shot: {} as ShotPlan, startSec: 1, frames: 30 }], 0.2, 0.5);
    assert.deepEqual(padded.map((s) => [Math.round(s.startSec * 30), s.frames]), [[0, 36], [36, 45]]);

    const plan = (word_start: number): ShotPlan => ({ visual_type: 'stock', visual_query: 'q', covers: 'c', word_start, word_count: 4 });
    const composed = await composeBeatTrack({
      beatIndex: 0, shots: [plan(0), plan(4)], words: null, audioDurationSec: 2, outputDir: dir, leadInSec: 0.2, tailSec: 0.5,
      renderShot: async (slot, clipPath) => (await makeColorClip('#334455', slot.frames, clipPath), { clipPath, renderedType: 'stock' }),
    });
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', composed.trackPath]);
    assert.equal(Number(stdout.trim().replace(/,$/, '')), 81, '0.2 s + 2 s + 0.5 s at 30 fps');
    const sidecar = JSON.parse(await fs.readFile(`${composed.trackPath}.shots.json`, 'utf-8'));
    assert.equal(sidecar.leadInSec, 0.2);
  });

  it('starts the voice after the lead-in and dips in from black', async () => {
    const still = path.join(dir, 'still.png');
    const voice = path.join(dir, 'voice.wav');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=640x360', '-frames:v', '1', still]);
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-t', '1', voice]);
    const out = path.join(dir, 'scene.mp4');
    await renderBeatScene({ visualPath: still, audioPath: voice, durationMs: 1000, outputPath: out, leadInSeconds: 0.5, pauseSeconds: 0.3, dipIn: true, stillMotion: 'static' });

    const { stdout: dur } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
    assert.ok(Math.abs(Number.parseFloat(dur) - 1.8) < 0.06, `scene is lead-in + voice + pause (${dur.trim()})`);
    const level = async (from: string, len: string) => {
      const { stderr } = await execFileAsync('ffmpeg', ['-v', 'info', '-ss', from, '-t', len, '-i', out, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
      return Number.parseFloat(stderr.match(/max_volume: (-?[\d.]+|-inf)/)?.[1] ?? '-91');
    };
    assert.ok((await level('0', '0.4')) < -60, 'silent during the lead-in');
    assert.ok((await level('0.6', '0.5')) > -30, 'voice after it');
    const { stdout: px } = await execFileAsync('ffmpeg', ['-v', 'error', '-i', out, '-vf', 'scale=1:1,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-']);
    assert.ok(Buffer.from(px, 'binary')[0] < 40, 'first frame is black (dip in)');
  });
});
