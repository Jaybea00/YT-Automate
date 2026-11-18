import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { STYLE_PACKS, STYLE_GROUP_LABELS } from '../../src/lib/styles/packs.ts';
import { DOODLE, SCROLL } from '../../src/lib/styles/themes.ts';
import { drawingCode, parseDrawingCode } from '../../src/lib/stickman/drawing-codes.ts';
import { fetchVerses, parseVerseRef } from '../../src/lib/stickman/bible.ts';
import { asDrawnBeat, drawnPacing, fitDrawingBudget, planShotsWith, shotCountForBeat, verifyShot } from '../../src/lib/script/shot-planner.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import type { ScriptBeat, ShotPlan } from '../../src/lib/script/generate-script.ts';
import { findDrawing, listDrawings, saveDrawing } from '../../src/pipeline/visuals/drawings-store.ts';
import { codedMatches } from '../../src/pipeline/visuals/smart-match.ts';
import { motionForDrawing, renderDrawing } from '../../src/pipeline/visuals/drawing-shot.ts';
import { drawingBackground } from '../../src/pipeline/visuals/clips.ts';
import { shotCues } from '../../src/pipeline/assembly/sound-design.ts';
import { paletteFor } from '../../src/pipeline/assembly/palettes.ts';
import { REAL_SOUNDS } from '../../src/pipeline/assembly/real-sfx.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('Stickman styles', () => {
  it('defines POV and Bible as drawn styles in their own group, with the doodle looks', () => {
    assert.equal(STYLE_PACKS.stickman_pov.drawn.secondsPerShot, 3);
    assert.equal(STYLE_PACKS.stickman_bible.drawn.secondsPerShot, 4);
    assert.equal(STYLE_PACKS.stickman_pov.theme, DOODLE);
    assert.equal(STYLE_PACKS.stickman_bible.theme, SCROLL);
    assert.deepEqual([...STYLE_PACKS.stickman_bible.signatureShots], ['verse']);
    assert.equal(STYLE_PACKS.stickman_pov.group, 'stickman');
    assert.ok(STYLE_GROUP_LABELS.stickman);
    assert.match(STYLE_PACKS.stickman_bible.voice, /World English Bible/);
    assert.match(STYLE_PACKS.stickman_pov.voice, /second person/);
  });
});

describe('Drawing codes', () => {
  it('codes shots from 1 as the pages show them, and reads the ways people name files', () => {
    assert.equal(drawingCode(4, 1), 'B05_S2');
    assert.equal(drawingCode(11, 0), 'B12_S1');
    for (const name of ['B05_S2.png', 'b5-s2.jpg', 'B05S2.png', 'beat 5 shot 2.png', 'Beat05_Shot02 v2.png', 'B5 S2.webp']) {
      assert.deepEqual(parseDrawingCode(name), { beat_index: 4, shot_index: 1 }, name);
    }
    assert.deepEqual(parseDrawingCode('final B12_S3 colour.png'), { beat_index: 11, shot_index: 2 });
    for (const name of ['IMG_2034.jpg', 'bus5.png', 'B00_S1.png', 'drawing.png']) assert.equal(parseDrawingCode(name), null, name);
  });
});

describe('Bible verses', () => {
  let dir = '';
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bible-'));
    process.env.BIBLE_CACHE_DIR = dir;
  });
  after(async () => {
    delete process.env.BIBLE_CACHE_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads references in the usual forms', () => {
    assert.deepEqual(parseVerseRef('Exodus 14:21'), { book: 'Exodus', chapter: 14, from: 21, to: 21 });
    assert.deepEqual(parseVerseRef('Ex. 14:21-22'), { book: 'Exodus', chapter: 14, from: 21, to: 22 });
    assert.deepEqual(parseVerseRef('1 John 4:8'), { book: '1 John', chapter: 4, from: 8, to: 8 });
    assert.deepEqual(parseVerseRef('Psalm 23:1'), { book: 'Psalms', chapter: 23, from: 1, to: 1 });
    for (const bad of ['Hezekiah 3:1', 'Exodus 14', 'John 3:17-16', 'the flood']) assert.equal(parseVerseRef(bad), null, bad);
  });

  it('fetches the World English Bible words by reference, caches them, and caps a card at three verses', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ verses: [{ text: 'Moses stretched out his hand over the sea,\n' }, { text: 'and the LORD caused the sea to go back.\n' }, { text: 'Third.' }] }), { status: 200 });
    }) as typeof fetch;
    const passage = await fetchVerses('Exodus 14:21-26', 'webbe', fetcher);
    assert.equal(passage?.reference, 'Exodus 14:21-23', 'cut to three verses');
    assert.equal(passage?.text, 'Moses stretched out his hand over the sea, and the LORD caused the sea to go back. Third.');
    assert.match(urls[0], /bible-api\.com\/Exodus%2014%3A21-23\?translation=webbe/);
    await fetchVerses('Exodus 14:21-26', 'webbe', fetcher);
    assert.equal(urls.length, 1, 'the second card comes from the cache');
  });

  it('shows no words when the reference does not exist or the service is down', async () => {
    assert.equal(await fetchVerses('Hezekiah 3:1', 'webbe', (async () => new Response('{}')) as typeof fetch), null);
    assert.equal(await fetchVerses('Jude 1:99', 'webbe', (async () => new Response('not found', { status: 404 })) as typeof fetch), null);
    assert.equal(await fetchVerses('Jude 1:3', 'webbe', (async () => { throw new Error('offline'); }) as typeof fetch), null);
  });
});

describe('Drawn shot planning', () => {
  const beat = (index: number, text: string): ScriptBeat => ({ index, text, visual_type: 'stock', visual_query: 'scene', duration_estimate_seconds: 6 });

  it('cuts drawn videos faster, and a drawing budget spreads that many drawings over the narration', () => {
    const text = words(40); // about 17 s of narration
    assert.equal(shotCountForBeat(text), 4, 'documentary pace caps at four shots');
    assert.ok(shotCountForBeat(text, drawnPacing([beat(0, text)], 3)) > 4, 'a new drawing about every 3 s');
    const fewer = drawnPacing([beat(0, text)], 3, 1);
    assert.equal(fewer.secondsPerShot, 8, 'one drawing for 17 s: as slow as allowed');
    assert.equal(drawnPacing([beat(0, text)], 3, 1000).secondsPerShot, 2, 'never faster than a drawing every 2 s');
  });

  it('lands on exactly the drawing budget by merging neighbouring drawings, shortest first', () => {
    const d = (covers: string, start: number, scene: string): ShotPlan => ({
      visual_type: 'drawing', visual_query: 'q', covers, word_start: start, word_count: covers.split(' ').length,
      drawing: { scene, framing: 'medium', mood: 'neutral', characters: [] },
    });
    const stat: ShotPlan = { visual_type: 'stat', visual_query: 'n', covers: 'thirty km', word_start: 6, word_count: 2, stat: { value: 30, label: 'km' } };
    const beats: ScriptBeat[] = [
      { ...beat(0, 'a b c d e f thirty km'), shots: [d('a b', 0, 'first'), d('c d e f', 2, 'second'), stat] },
      { ...beat(1, 'g h i j k l m'), shots: [d('g h i', 0, 'third'), d('j', 3, 'fourth'), d('k l m', 4, 'fifth')] },
      { ...beat(2, 'n o'), shots: [d('n o', 0, 'sixth')] },
    ];
    const count = (bs: ScriptBeat[]) => bs.reduce((n, b) => n + b.shots!.filter((s) => s.visual_type === 'drawing').length, 0);
    assert.equal(count(beats), 6);
    const four = fitDrawingBudget(beats, 4);
    assert.equal(count(four), 4);
    // The shortest pair (g h i + j, 4 words; the earlier of two ties) went first, then (a b + c d e f, 6 words)
    assert.deepEqual(four[1].shots!.map((s) => [s.covers, s.drawing?.scene]), [['g h i j', 'third'], ['k l m', 'fifth']]);
    assert.deepEqual(four[0].shots!.map((s) => s.visual_type), ['drawing', 'stat'], 'graphics are never merged away');
    assert.deepEqual([four[0].shots![0].word_start, four[0].shots![0].word_count], [0, 6]);
    assert.equal(count(fitDrawingBudget(beats, 1)), 3, 'never below one drawing per beat');
    assert.equal(count(fitDrawingBudget(beats, 10)), 6, 'under budget: left as planned');
    assert.equal(count(beats), 6, 'the input is not changed');
  });

  it('turns every searched shot into a drawing and gives an unplanned beat one drawing', () => {
    const shots: ShotPlan[] = [
      { visual_type: 'stock', visual_query: 'roman road', covers: 'You march', word_start: 0, word_count: 2 },
      { visual_type: 'stat', visual_query: 'n', covers: 'for 30 km', word_start: 2, word_count: 3, stat: { value: 30, suffix: ' km', label: 'a day' } },
      { visual_type: 'geo_map', visual_query: 'm', covers: 'to Gaul', word_start: 5, word_count: 2, map: { places: ['Gaul'], mode: 'fly' } },
    ];
    const drawn = asDrawnBeat({ ...beat(0, 'You march for 30 km to Gaul'), shots });
    assert.deepEqual(drawn.shots!.map((s) => s.visual_type), ['drawing', 'stat', 'geo_map']);
    assert.match(drawn.shots![0].drawing!.scene, /You march/);
    assert.equal(drawn.shots![2].map!.mode, 'locate', 'no satellite flyover in a doodle video');
    const bare = asDrawnBeat(beat(1, 'Day three. The rain never stops.'));
    assert.equal(bare.shots!.length, 1);
    assert.equal(bare.shots![0].word_count, 6);
  });

  it('keeps a verse card only for a real reference to a book the story names', () => {
    const story = beat(0, 'In Exodus chapter fourteen, Moses stretched out his hand over the sea.');
    const verse = (reference: string) => verifyShot({ visual_type: 'verse', covers: story.text, visual_query: 'v', verse: { reference } }, story, []);
    assert.deepEqual(verse('Ex 14:21').verse, { reference: 'Exodus 14:21' });
    assert.notEqual(verse('Genesis 7:11').visual_type, 'verse', 'Genesis is never named here');
    assert.notEqual(verse('Exodus 14:21-28').visual_type, 'verse', 'too long for a card');
    assert.notEqual(verse('Hezekiah 3:1').visual_type, 'verse');
    // Named a beat earlier still counts
    const next = beat(1, 'But Moses tells them, "Don\'t be afraid. Stand still."');
    const quoted = verifyShot({ visual_type: 'verse', covers: next.text, visual_query: 'v', verse: { reference: 'Exodus 14:13' } }, next, [], `${story.text} ${next.text}`);
    assert.deepEqual(quoted.verse, { reference: 'Exodus 14:13' });
  });

  it('briefs the director for drawings and never plans footage searches or illustrations', async () => {
    const prompts: Array<{ system?: string; prompt: string }> = [];
    const text = 'You wake up in a cold Roman barracks. A trumpet blares, and the centurion is already shouting your name.';
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async (req) => {
        prompts.push({ system: req.system, prompt: req.prompt });
        return {
          data: {
            beats: [
              {
                index: 0,
                shots: [
                  { visual_type: 'drawing', covers: 'You wake up in a cold Roman barracks.', visual_query: 'barracks', drawing: { scene: 'You, a young recruit, wake on a straw bed in a cold stone barracks', framing: 'wide', mood: 'calm', characters: ['You'] } },
                  { visual_type: 'illustration', covers: 'A trumpet blares,', visual_query: 'trumpet', illustration: { prompt: 'a roman trumpet glowing at dawn over a camp' } },
                  { visual_type: 'stock', covers: 'and the centurion is already shouting your name.', visual_query: 'angry officer' },
                ],
              },
            ],
          } as never,
          usage: {},
        };
      },
    };
    const planned = await planShotsWith(llm, { apiKey: 'k' }, { title_options: [], beats: [beat(0, text)] }, 'A day as a Roman soldier', { style: 'stickman_pov', illustrations: true });
    assert.match(prompts[0].system ?? '', /stickman YouTube channel/);
    assert.doesNotMatch(prompts[0].system ?? '', /"stock": cinematic b-roll/);
    assert.match(prompts[0].system ?? '', /"stat": one striking number/, 'the graphics rules are shared with every style');
    assert.doesNotMatch(prompts[0].prompt, /"illustration"/, 'no AI illustrations offered');
    const shots = planned.beats[0].shots!;
    assert.deepEqual(shots.map((s) => s.visual_type), ['drawing', 'drawing', 'drawing']);
    assert.deepEqual(shots[0].drawing, { scene: 'You, a young recruit, wake on a straw bed in a cold stone barracks', framing: 'wide', mood: 'calm', characters: ['You'] });
  });
});

describe('Drawings on disk and in batch uploads', () => {
  let dir = '';
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drawings-'));
    process.env.DRAWINGS_DIR = path.join(dir, 'store');
  });
  after(async () => {
    delete process.env.DRAWINGS_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('files a drawing by code, replacing an earlier one in another format', async () => {
    const png = path.join(dir, 'a.png');
    const jpg = path.join(dir, 'b.jpg');
    await fs.writeFile(png, 'png');
    await fs.writeFile(jpg, 'jpg');
    await saveDrawing('vid1', 4, 1, png);
    assert.match((await findDrawing('vid1', 4, 1))!, /B05_S2\.png$/);
    await saveDrawing('vid1', 4, 1, jpg);
    assert.match((await findDrawing('vid1', 4, 1))!, /B05_S2\.jpg$/, 'the new drawing replaces the old one');
    assert.deepEqual([...(await listDrawings('vid1'))], ['B05_S2']);
    assert.equal(await findDrawing('vid1', 0, 0), null);
    await assert.rejects(saveDrawing('vid1', 0, 0, path.join(dir, 'clip.mp4')), /PNG, JPG or WebP/);
  });

  it('sends coded files straight to their shot, and leaves the rest for matching by eye', () => {
    const staged = [
      { id: 'f1', name: 'B01_S2.png', path: 'x', isVideo: false, durationSec: 0 },
      { id: 'f2', name: 'holiday.jpg', path: 'x', isVideo: false, durationSec: 0 },
      { id: 'f3', name: 'B09_S1.png', path: 'x', isVideo: false, durationSec: 0 },
      { id: 'f4', name: 'b1-s2 v2.png', path: 'x', isVideo: false, durationSec: 0 },
    ];
    const targets = [
      { beat_index: 0, shot_index: 1, query: 'q', covers: 'c', durationSec: 3 },
      { beat_index: 1, shot_index: 0, query: 'q', covers: 'c', durationSec: 3 },
    ];
    const matches = codedMatches(staged, targets);
    assert.equal(matches.length, 1, 'B09_S1 points at no drawing shot; holiday.jpg has no code');
    assert.equal(matches[0].fileId, 'f4', 'the later file with the same code wins');
    assert.equal(matches[0].reason, 'File name: B01_S2');
    assert.equal(matches[0].score, 10);
  });
});

describe('Drawing shots on screen', () => {
  it('moves a drawing for its mood, and calm ones through the gentle camera moves', () => {
    const shot = (mood: string) => ({ drawing: { mood } }) as unknown as ShotPlan;
    const counter = { next: 0 };
    assert.equal(motionForDrawing(shot('surprised'), counter), 'pop');
    assert.equal(motionForDrawing(shot('scared'), counter), 'shake');
    assert.equal(motionForDrawing(shot('happy'), counter), 'bounce');
    assert.equal(motionForDrawing(shot('neutral'), counter), 'zoom_in');
    assert.equal(motionForDrawing(shot('calm'), counter), 'pan_right');
  });

  it('reads an opaque drawing\'s own background so no box shows, and lets transparent ones take the paper', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drawbg-'));
    try {
      const cream = path.join(dir, 'cream.jpg');
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xf2e6c9:s=400x300,drawbox=x=150:y=100:w=100:h=100:color=black:t=8', '-frames:v', '1', cream]);
      const bg = (await drawingBackground(cream))!;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
      assert.ok(Math.abs(r - 0xf2) <= 3 && Math.abs(g - 0xe6) <= 3 && Math.abs(b - 0xc9) <= 3, bg);
      const clear = path.join(dir, 'clear.png');
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=400x300,format=rgba', '-frames:v', '1', clear]);
      assert.equal(await drawingBackground(clear), null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('shows the drawing once filed, and the narration as doodle type marked "drawing needed" until then', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drawshot-'));
    try {
      const art = path.join(dir, 'art.png');
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=800x600,drawbox=x=350:y=200:w=100:h=100:color=black:t=8', '-frames:v', '1', art]);
      const shot: ShotPlan = {
        visual_type: 'drawing', visual_query: 'barracks', covers: 'You wake up in a cold barracks', word_start: 0, word_count: 6,
        drawing: { scene: 'You wake on a straw bed', framing: 'wide', mood: 'surprised', characters: ['You'] },
      };
      const ctx = { beatIndex: 2, downloadDir: dir, theme: themeForStyle('stickman_pov'), usedSources: new Set<string>(), motionCounter: { next: 0 }, drawn: true };
      const withArt = await renderDrawing(shot, { shot, startSec: 0, frames: 30, index: 1 }, path.join(dir, 'drawn.mp4'), {
        ...ctx,
        drawingFile: async (beat, index) => (beat === 2 && index === 1 ? art : null),
      });
      assert.equal(withArt.renderedType, 'drawing');
      assert.equal(withArt.note, 'drawing (pop) (centre)', 'no vision model here, so the camera moves around the centre');
      assert.equal(withArt.drawingNeeded, undefined);
      const waiting = await renderDrawing(shot, { shot, startSec: 0, frames: 30, index: 0 }, path.join(dir, 'card.mp4'), { ...ctx, drawingFile: async () => null });
      assert.equal(waiting.renderedType, 'kinetic_text');
      assert.equal(waiting.drawingNeeded, true);
      for (const clip of [withArt.clipPath, waiting.clipPath]) {
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', clip]);
        assert.equal(Number(stdout.trim().replace(/,$/, '')), 30);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('pops and jolts drawings with sound, turns verse cards like a page, and has a real recording for every stickman effect', () => {
    const cue = (renderedType: string, note?: string) => shotCues({ renderedType, durationSec: 3, note }).map((c) => c.sound);
    assert.deepEqual(cue('drawing', 'drawing (pop)'), ['ping']);
    assert.deepEqual(cue('drawing', 'drawing (shake)'), ['impact']);
    assert.deepEqual(cue('drawing', 'drawing (zoom_in)'), []);
    assert.deepEqual(cue('verse'), ['paper']);
    for (const style of ['stickman_pov', 'stickman_bible']) {
      for (const real of Object.values(paletteFor(style))) assert.ok(real && real in REAL_SOUNDS, `${style}: ${real}`);
    }
    assert.equal(paletteFor('stickman_pov').impact, 'cartoon_boing');
    assert.equal(paletteFor('stickman_bible').chime, 'harp_gliss');
  });
});

describe('Drawing camera, reveals and doodle captions', () => {
  const fit = { srcWidth: 918, srcHeight: 512, scale: 3840 / 918, offsetX: 0, offsetY: (2160 - 512 * (3840 / 918)) / 2 };

  it('aims camera moves at the drawing\'s subject and cuts long shots to a close-up of it', async () => {
    const { drawingCamera, CLOSE_UP_MIN_FRAMES } = await import('../../src/pipeline/visuals/clips.ts');
    const box: [number, number, number, number] = [0.2, 0.6, 0.6, 0.85];
    const short = drawingCamera('zoom_in', 90, { box, fit });
    assert.equal(short.closeUp, false, 'a 3 s shot has no time for a close-up');
    assert.match(short.filter, /0\.725/, 'drifts toward the subject\'s centre (x = 0.725 of the page)');
    const long = drawingCamera('zoom_in', CLOSE_UP_MIN_FRAMES + 30, { box, fit });
    assert.equal(long.closeUp, true);
    assert.match(long.filter, /if\(lt\(on,99\)/, 'cuts at about 55% of the shot');
    assert.equal(drawingCamera('pan_left', 300, { box, fit }).closeUp, false, 'pans stay pans');
    assert.equal(drawingCamera('zoom_in', 300, null).closeUp, false, 'no focus: the plain moves');
    // A small drawing can't be cropped tight without going soft
    const tiny = { srcWidth: 400, srcHeight: 225, scale: 9.6, offsetX: 0, offsetY: 0 };
    assert.equal(drawingCamera('zoom_in', 300, { box, fit: tiny }).closeUp, false);
  });

  it('draws on the first drawing and scene-setting ones, never closer than three drawings apart', async () => {
    const { revealShots } = await import('../../src/pipeline/visuals/drawing-shot.ts');
    const d = (framing: 'wide' | 'medium' | 'close'): ShotPlan => ({
      visual_type: 'drawing', visual_query: 'q', covers: 'c', word_start: 0, word_count: 3,
      drawing: { scene: 's', framing, mood: 'neutral', characters: [] },
    });
    const stat = { visual_type: 'stat', visual_query: 'n', covers: 'c', word_start: 0, word_count: 2 } as ShotPlan;
    const beats = [
      { index: 0, shots: [d('medium'), d('wide'), stat] },
      { index: 1, shots: [d('close'), d('medium'), d('wide')] },
      { index: 2, shots: [d('wide'), d('close'), d('close'), d('close'), d('wide')] },
    ];
    // First drawing; then the wide at 1:2 (3 drawings later); 2:0 is too soon; 2:4 is 4 later
    assert.deepEqual([...revealShots(beats)], ['0:0', '1:2', '2:4']);
  });

  it('describes the subject by its scene, since names are not written in drawings', async () => {
    const { focusTarget, usableFocus } = await import('../../src/pipeline/visuals/drawing-focus.ts');
    const shot = { drawing: { scene: 'You toss a stone', characters: ['You'] }, covers: 'x' } as unknown as ShotPlan;
    assert.match(focusTarget(shot), /names are not written in the drawing\)\. The scene: You toss a stone/);
    assert.equal(usableFocus([0.1, 0.1, 0.5, 0.4]), true);
    assert.equal(usableFocus([0, 0, 1, 1]), false, 'the whole picture is no focus');
    assert.equal(usableFocus([0.5, 0.5, 0.51, 0.52]), false, 'a sliver is no focus');
  });

  it('writes doodle captions as dark handwriting with a white outline, the spoken word in the ink colour', async () => {
    const { generateAssCaptions } = await import('../../src/pipeline/assembly/captions.ts');
    const { assContent } = generateAssCaptions({
      beats: [{ index: 0, text: 'You wake up', duration_estimate_seconds: 2 }],
      preset: 'doodle',
      words: { 0: [{ word: 'You', start: 0, end: 0.3 }, { word: 'wake', start: 0.3, end: 0.6 }, { word: 'up', start: 0.6, end: 0.9 }] },
      highlightHex: '#d64545',
      beatStartMs: [0],
    });
    assert.match(assContent, /Style: Doodle, Ink Free, 88, &H001D1D1D, &H00FFFFFF, &H00FFFFFF, &H00000000, -1,/);
    assert.ok(assContent.includes('{\\c&H4545D6&\\fscx114\\fscy114}wake'), 'the spoken word pops in red');
    assert.equal(STYLE_PACKS.stickman_pov.defaults.captionPreset, 'doodle');
    assert.equal(STYLE_PACKS.stickman_bible.defaults.captionPreset, 'doodle');
  });

  it('draws a scene-setting drawing on, then moves the camera, at the exact length', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reveal-'));
    try {
      const art = path.join(dir, 'art.png');
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=800x450,drawbox=x=350:y=150:w=100:h=150:color=black:t=8', '-frames:v', '1', art]);
      const shot: ShotPlan = {
        visual_type: 'drawing', visual_query: 'cave', covers: 'You enter the cave', word_start: 0, word_count: 4,
        drawing: { scene: 'A dark cave mouth', framing: 'wide', mood: 'tense', characters: [] },
      };
      const out = path.join(dir, 'shot.mp4');
      const r = await renderDrawing(shot, { shot, startSec: 0, frames: 75, index: 0 }, out, {
        beatIndex: 0, downloadDir: dir, theme: themeForStyle('stickman_pov'), usedSources: new Set<string>(), motionCounter: { next: 0 },
        drawn: true, drawingFile: async () => art, reveal: new Set(['0:0']),
      });
      assert.match(r.note!, /drawn on/);
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out]);
      assert.equal(Number(stdout.trim().replace(/,$/, '')), 75);
      // The first frame is the empty page; by the end of the reveal the drawing is there
      const mean = async (t: number) => {
        const { stdout: o } = await execFileAsync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 20 });
        const px = o as unknown as Buffer;
        return px.reduce((a, b) => a + b, 0) / px.length;
      };
      assert.ok((await mean(0)) > (await mean(1.5)) + 1, 'lines are drawn in after the empty first frame');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Labels and speech bubbles on drawings', () => {
  it('keeps a label only for a name the narration or research uses, and a bubble only for the narration\'s own words', async () => {
    const { checkNote } = await import('../../src/lib/stickman/drawing-notes.ts');
    const covers = 'The old man says, "Fetch more wood!" as the fire dies.';
    const ground = 'People played the Royal Game of Ur more than four thousand years ago.';
    assert.deepEqual(checkNote({ label: { text: 'Royal Game of Ur', target: 'the board game' } }, covers, ground).label, { text: 'Royal Game of Ur', target: 'the board game' });
    assert.equal(checkNote({ label: { text: 'Senet', target: 'the board' } }, covers, ground).label, undefined, 'never named: no label');
    assert.equal(checkNote({ label: { text: 'The famous Royal Game of Ur board', target: 'x' } }, covers, ground).label, undefined, 'too long');
    assert.deepEqual(checkNote({ bubble: { text: '"Fetch more wood!"', speaker: 'the old man' } }, covers, ground).bubble, { text: 'Fetch more wood!', speaker: 'the old man' });
    assert.equal(checkNote({ bubble: { text: 'Bring me logs!', speaker: 'the old man' } }, covers, ground).bubble, undefined, 'words not in the narration');
  });

  it('spreads labels out and merges the AI\'s picks into the brief without touching shots or codes', async () => {
    const { planDrawingNotes } = await import('../../src/lib/stickman/drawing-notes.ts');
    const d = (covers: string): ShotPlan => ({
      visual_type: 'drawing', visual_query: 'q', covers, word_start: 0, word_count: covers.split(' ').length,
      drawing: { scene: 'a scene', framing: 'medium', mood: 'neutral', characters: [] },
    });
    const beat = (index: number, text: string): ScriptBeat => ({ index, text, visual_type: 'stock', visual_query: 'q', duration_estimate_seconds: 4 });
    const beats: ScriptBeat[] = [
      { ...beat(0, 'They played the Royal Game of Ur. Then chariot races came.'), shots: [d('They played the Royal Game of Ur.'), d('Then chariot races came.')] },
      { ...beat(1, 'A flute made of bone sang.'), shots: [d('A flute made of bone sang.')] },
    ];
    const llm: LLMProvider = {
      kind: 'llm', id: 'mock', generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => ({
        data: { notes: [
          { code: 'B01_S1', label: { text: 'Royal Game of Ur', target: 'the board' } },
          { code: 'B01_S2', label: { text: 'chariot races', target: 'the chariots' } },
          { code: 'B09_S9', label: { text: 'Royal Game of Ur', target: 'x' } },
        ] } as never,
        usage: {},
      }),
    };
    const noted = await planDrawingNotes(llm, { apiKey: 'k' }, beats);
    assert.deepEqual(noted.map((b) => b.shots!.length), [2, 1], 'shots unchanged');
    assert.equal(noted[0].shots![0].drawing!.label!.text, 'Royal Game of Ur');
    assert.equal(noted[0].shots![1].drawing!.label, undefined, 'the next drawing is too close to the last label');
    const failing: LLMProvider = { ...llm, generateJson: async () => { throw new Error('quota'); } };
    const unchanged = await planDrawingNotes(failing, { apiKey: 'k' }, noted);
    assert.equal(unchanged[0].shots![0].drawing!.label, undefined, 'a failed call clears the notes rather than keeping stale ones');
    assert.equal(unchanged[0].shots!.length, 2, 'and never breaks the plan');
  });

  it('escapes label and bubble text, and lays them out clear of the captions', async () => {
    const { noteLayerHtml } = await import('../../src/pipeline/visuals/drawing-notes-layer.ts');
    const html = noteLayerHtml({ label: { text: '<b>Ur</b>', target: [800, 1500, 1200, 2000] }, bubble: { text: 'Run & hide!', speaker: [600, 2400, 2100, 3200] } }, themeForStyle('stickman_pov'));
    assert.ok(html.includes('&lt;b&gt;Ur&lt;/b&gt;'));
    assert.ok(html.includes('Run &amp; hide!'));
    assert.match(html, /CAPTIONS=H\*0\.8/, 'nothing is placed in the bottom fifth, where captions run');
  });

  it('moves the label with the camera and pops it in with a sound', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-'));
    try {
      const { makeDrawingClip } = await import('../../src/pipeline/visuals/clips.ts');
      const art = path.join(dir, 'art.png');
      const layer = path.join(dir, 'layer.png');
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=800x450', '-frames:v', '1', art]);
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=c=red:s=3840x2160,format=rgba,geq=r=255:g=0:b=0:a='if(between(X\,1700\,2140)*between(Y\,900\,1260)\,255\,0)'", '-frames:v', '1', layer]);
      const out = path.join(dir, 'shot.mp4');
      await makeDrawingClip(art, 60, out, 'zoom_in', '#ffffff', { layer, layerAt: 0.35 });
      const centre = async (t: number) => {
        const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'crop=40:40:940:520,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
        return stdout as unknown as Buffer;
      };
      const [r0, g0] = await centre(0);
      const [r1, g1] = await centre(1.8);
      assert.ok(r0 > 200 && g0 > 200, 'invisible before it fades in');
      assert.ok(r1 > 200 && g1 < 80, 'red (the layer) at the centre once in');
      const cue = shotCues({ renderedType: 'drawing', durationSec: 3, note: 'drawing (zoom_in) + label' });
      assert.deepEqual(cue.map((c) => [c.at, c.sound]), [[0.35, 'tick']]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
