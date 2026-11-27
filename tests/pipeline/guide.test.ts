import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { alignWords, cardWindows, cropFor, cutLengths, cutTimes, fillCuts, parseMarkup, planGuide, spokenParts, toFrames, voiceText, chapterList, clockTime } from '../../src/pipeline/guide/timeline.ts';
import { captionAss, captionGroups, cardDocument, markedHtml, shout, titleDocument } from '../../src/pipeline/guide/look.ts';
import { commonCrop, guideTemplate, guideFile, isGuideId } from '../../src/pipeline/guide/store.ts';
import { guideMixGraph, guideWords, renderGuide } from '../../src/pipeline/guide/render.ts';
import { initScript, mergeConfig, motionConfig, objectEnd, patchComponent } from '../../src/pipeline/guide/motion.ts';
import { motionWindows } from '../../src/pipeline/guide/timeline.ts';
import type { GuideProject } from '../../src/pipeline/guide/types.ts';

const run = promisify(execFile);
const sum = (xs: number[]) => Number(xs.reduce((a, b) => a + b, 0).toFixed(3));
// Lengths are whole frames: compare them in frames
const frames = (xs: number[]) => xs.reduce((a, b) => a + toFrames(b), 0);

describe('Guide script marks', () => {
  it('reads *green* and ~red~ words, across several words and next to punctuation', () => {
    const { plain, words } = parseMarkup("Here's five *crazy things* you could ~never~ do, *right*?");
    assert.equal(plain, "Here's five crazy things you could never do, right?");
    assert.deepEqual(
      words.filter((w) => w.colour).map((w) => [w.word, w.colour]),
      [['crazy', 'green'], ['things', 'green'], ['never', 'red'], ['right?', 'green']],
    );
    assert.equal(markedHtml('5 *CRAZY* THINGS <b> ~NOT~'), '5 <span class="g">CRAZY</span> THINGS &lt;b&gt; <span class="r">NOT</span>');
  });

  it('times the script words by the voice, even where the voice says them differently', () => {
    const marked = parseMarkup('You make *$40,000* in one day.').words;
    const spoken = [
      { word: 'You', start: 0, end: 0.2 }, { word: 'make', start: 0.2, end: 0.4 },
      { word: 'forty', start: 0.45, end: 0.7 }, { word: 'thousand', start: 0.7, end: 1 }, { word: 'dollars', start: 1, end: 1.3 },
      { word: 'in', start: 1.35, end: 1.45 }, { word: 'one', start: 1.45, end: 1.6 }, { word: 'day', start: 1.6, end: 1.9 }, { word: '.', start: 1.9, end: 1.9 },
    ];
    const timed = alignWords(marked, spoken, 2);
    assert.deepEqual(timed.map((w) => w.word), ['You', 'make', '$40,000', 'in', 'one', 'day.']);
    assert.equal(timed[2].colour, 'green');
    // The money takes the time between "make" and "in"
    assert.equal(timed[2].start, 0.4);
    assert.equal(timed[2].end, 1.35);
    assert.equal(timed[5].start, 1.6);
    // Nothing from the voice: spread over the line
    const even = alignWords(parseMarkup('a b c d').words, [], 2);
    assert.deepEqual(even.map((w) => [w.start, w.end]), [[0, 0.5], [0.5, 1], [1, 1.5], [1.5, 2]]);
  });
});

describe('Guide cuts', () => {
  it('cuts a part into uneven pieces around the asked length that add up exactly', () => {
    const lens = cutLengths(7.5, 1.5);
    assert.equal(lens.length, 5);
    assert.equal(frames(lens), 225);
    assert.ok(new Set(lens).size > 1);
    for (const l of lens) assert.ok(Math.abs(toFrames(l) / 30 - l) < 0.001);
  });

  it('spreads jump cuts through plenty of footage, in order, never crossing from one recording to the next', () => {
    const shots = [{ file: 'a.mp4', from: 10, to: 20 }, { file: 'b.mp4', from: 0, to: 8, focusX: 0.3 }];
    const cuts = fillCuts(shots, 6, 1.5);
    assert.equal(frames(cuts.map((c) => c.outSec)), 180);
    for (const c of cuts) {
      const s = shots.find((x) => x.file === c.file)!;
      assert.ok(c.from >= s.from && c.from + c.srcSec <= s.to + 1e-6, `${c.file} ${c.from}+${c.srcSec}`);
      assert.equal(c.srcSec, c.outSec);
    }
    assert.ok(cuts.some((c) => c.file === 'a.mp4') && cuts.some((c) => c.file === 'b.mp4'));
    assert.equal(cuts.find((c) => c.file === 'b.mp4')!.focusX, 0.3);
    // In order through the footage
    const order = cuts.map((c) => (c.file === 'a.mp4' ? c.from : 100 + c.from));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  it('slows short footage down to fill, and plays the opening shot as one cut', () => {
    const slow = fillCuts([{ file: 'a.mp4', from: 0, to: 3 }], 4, 1.5);
    assert.equal(frames(slow.map((c) => c.outSec)), 120);
    for (const c of slow) assert.ok(c.srcSec < c.outSec && c.srcSec >= c.outSec * 0.6 - 1e-6);
    const opening = fillCuts([{ file: 'o.mp4', from: 5, to: 7 }, { file: 'x.mp4', from: 0, to: 10 }], 4, 1.5, { firstWhole: true });
    assert.deepEqual([opening[0].file, opening[0].from, opening[0].srcSec, opening[0].outSec], ['o.mp4', 5, 2, 2]);
    assert.equal(frames(opening.map((c) => c.outSec)), 120);
    assert.ok(opening.slice(1).every((c) => c.file === 'x.mp4'));
  });

  it('crops widescreen to a vertical window that follows the focus, and keeps vertical footage whole', () => {
    assert.deepEqual(cropFor({ width: 3840, height: 2160 }), { w: 1214, h: 2160, x: 1313, y: 0 });
    assert.deepEqual(cropFor({ width: 1920, height: 1080 }, 0), { w: 606, h: 1080, x: 0, y: 0 });
    assert.deepEqual(cropFor({ width: 1920, height: 1080 }, 1), { w: 606, h: 1080, x: 1314, y: 0 });
    assert.deepEqual(cropFor({ width: 1080, height: 1920 }), { w: 1080, h: 1920, x: 0, y: 0 });
    // A zoom takes a smaller window around the focus, kept inside the picture
    assert.deepEqual(cropFor({ width: 1920, height: 1080 }, 0.5, 2, 0.45), { w: 302, h: 540, x: 809, y: 216 });
    assert.deepEqual(cropFor({ width: 1920, height: 1080 }, 1, 2, 1), { w: 302, h: 540, x: 1618, y: 540 });
    assert.deepEqual(cropFor({ width: 720, height: 720 }, 0.5, 1), { w: 404, h: 720, x: 158, y: 0 });
  });
});

const guide = (over: Partial<GuideProject> = {}): GuideProject => ({
  ...guideTemplate('test-guide', '2026-11-24T00:00:00Z'),
  hook: "Here's three *crazy* things.",
  opener: { file: 'footage/opener.mp4', from: 6, to: 8 },
  items: [
    { heading: 'Throw dog poop', emoji: '💩', say: 'Number one, throw *dog poop*.', shots: [{ file: 'footage/1.mp4', from: 0, to: 6 }] },
    { heading: 'Six stars', emoji: '🚨', say: 'Number two, ~six~ stars.', shots: [{ file: 'footage/2.mp4', from: 0, to: 6 }] },
  ],
  ...over,
});

describe('Guide layout', () => {
  it('runs hook, items, outro and the loop line back to back, the loop ending right where the opener starts', () => {
    const p = guide();
    const secs: Record<string, number> = { hook: 2, 'item-0': 3, 'item-1': 3, outro: 1.5, loop: 1.2 };
    const { segments, durationSec, warnings } = planGuide(p, (part) => secs[part]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(segments.map((s) => s.part), ['hook', 'item-0', 'item-1', 'outro', 'loop']);
    // Each part: its voice plus a short gap (the loop line ends right after it's said)
    assert.deepEqual(segments.map((s) => s.durationSec), [2.133, 3.133, 3.133, 1.633, 1.267]);
    assert.equal(durationSec, sum(segments.map((s) => s.durationSec)));
    for (const s of segments) assert.equal(frames(s.cuts.map((c) => c.outSec)), toFrames(s.durationSec), s.part);
    // The hook opens on the whole opening shot
    assert.deepEqual([segments[0].cuts[0].file, segments[0].cuts[0].from], ['footage/opener.mp4', 6]);
    // The loop line is one shot that ends exactly where the opener starts
    const loop = segments[4].cuts;
    assert.equal(loop.length, 1);
    assert.equal(Number((loop[0].from + loop[0].srcSec).toFixed(3)), 6);
    // The outro plays the footage before that
    for (const c of segments[3].cuts) assert.ok(c.file === 'footage/opener.mp4' && c.from + c.srcSec <= loop[0].from + 1e-6);
    // Cards as each item starts; cut points inside the Short only
    assert.deepEqual(cardWindows(segments).map((c) => [c.itemIndex, c.from]), [[0, 2.133], [1, 5.266]]);
    assert.ok(cutTimes(segments).every((t) => t > 0 && t < durationSec));
  });

  it('warns when the opener starts too early in its recording for a seamless loop', () => {
    const { segments, warnings } = planGuide(guide({ opener: { file: 'footage/opener.mp4', from: 0.2, to: 3 } }), () => 2);
    assert.match(warnings.join(' '), /loop needs about/);
    assert.equal(frames(segments[segments.length - 1].cuts.map((c) => c.outSec)), toFrames(segments[segments.length - 1].durationSec));
  });

  it('leaves out parts with nothing to say, and gives captions the voice timings on the Short clock', () => {
    const p = guide({ outro: '' });
    assert.deepEqual(spokenParts(p).map((x) => x.part), ['hook', 'item-0', 'item-1', 'loop']);
    const { segments } = planGuide(p, () => 1);
    const words = guideWords(p, segments, [{ part: 'item-1', text: 'Number two, six stars.', durationSec: 1, words: [{ word: 'Number', start: 0, end: 0.2 }, { word: 'two', start: 0.2, end: 0.4 }, { word: 'six', start: 0.5, end: 0.7 }, { word: 'stars', start: 0.7, end: 0.9 }] }]);
    const six = words.find((w) => w.word === 'six')!;
    assert.equal(six.colour, 'red');
    assert.equal(six.start, Number((segments[2].start + 0.5).toFixed(3)));
  });
});

describe('Guide look', () => {
  it('groups captions in threes and breaks after punctuation', () => {
    const w = (word: string, start: number) => ({ word, start, end: start + 0.2 });
    const groups = captionGroups([w('Number', 0), w('one,', 0.2), w('you', 0.5), w('can', 0.7), w('throw', 0.9), w('dog', 1.1), w('poop', 1.3)]);
    assert.deepEqual(groups.map((g) => g.map((x) => x.word).join(' ')), ['Number one,', 'you can throw', 'dog poop']);
  });

  it('writes captions that reveal word by word in bold italic, green and red, silent in quiet stretches', () => {
    const ass = captionAss(
      [{ word: 'six', start: 0, end: 0.3, colour: 'green' }, { word: 'stars', start: 0.3, end: 0.6 }, { word: 'never', start: 2, end: 2.3, colour: 'red' }],
      { durationSec: 3, quiet: [{ from: 1.9, to: 2.5 }] },
    );
    assert.match(ass, /Style: Guide, Segoe UI Black, 86, &H00FFFFFF, &H00FFFFFF, &H00000000, &H90000000, -1, -1,/);
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue'));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /\{\\c&H39E639&.*\}SIX\{\\r\} \{\\alpha&HFF&\}STARS/);
    assert.match(lines[1], /\{\\c&H39E639&\}SIX\{\\r\} \{\\fscx112.*\}STARS/);
    assert.ok(!ass.includes('NEVER'));
    // The channel's @handle in its corner for the whole Short
    const marked = captionAss([], { durationSec: 3, mark: { text: '@TheLuciaJasonDaily', corner: 'top-right' } });
    assert.match(marked, /Style: Mark, Segoe UI Black, 38,.*, 9, /);
    assert.match(marked, /Dialogue: 1,0:00:00\.00,0:00:03\.00,Mark,,0,0,0,,@TheLuciaJasonDaily/);
    assert.ok(!captionAss([], { durationSec: 3 }).includes('Mark'));
  });

  it('draws the title with its logo and the numbered card', () => {
    assert.match(titleDocument('5 *CRAZY* THINGS', 'data:image/png;base64,AA'), /<img src="data:image\/png;base64,AA">.*<span class="g">CRAZY<\/span>/);
    assert.match(cardDocument('Six-star wanted level', 2, { char: '🚨' }), /<span class="g">2\.<\/span> SIX-STAR WANTED LEVEL.*🚨/);
    assert.ok(!cardDocument('Six', null, null).includes('class="g"'));
    assert.match(titleDocument('5 *wild* attacks on NPCs', null), /5 <span class="g">WILD<\/span> ATTACKS ON NPCs/);
  });

  it('writes in capitals but keeps a plural s after an all-caps word', () => {
    assert.equal(shout("5 wild attacks on NPCs, *GPSs*! it's Lucia"), "5 WILD ATTACKS ON NPCs, *GPSs*! IT'S LUCIA");
    assert.equal(shout('Bus'), 'BUS');
  });

  it('finds black bars a recording was posted with, and crops inside them', () => {
    const log = 'x crop=3840:1920:0:120 y\n crop=3840:1920:0:120\n crop=3758:1920:0:120';
    assert.deepEqual(commonCrop(log), { w: 3840, h: 1920, x: 0, y: 120 });
    assert.equal(commonCrop('nothing'), null);
    assert.deepEqual(cropFor({ width: 3840, height: 2160, box: { x: 0, y: 120, w: 3840, h: 1920 } }), { w: 1080, h: 1920, x: 1380, y: 120 });
  });

  it('keeps guide files inside their folder', () => {
    assert.ok(isGuideId('5-crazy-things') && !isGuideId('../x') && !isGuideId('A'));
    const dir = path.resolve('storage/guides/x');
    assert.equal(guideFile(dir, 'footage/a.mp4'), path.join(dir, 'footage', 'a.mp4'));
    assert.throws(() => guideFile(dir, '../y/a.mp4'), /outside/);
    // A folder written with forward slashes is still the same folder
    assert.equal(guideFile(dir.replace(/\\/g, '/'), 'footage/a.mp4'), path.join(dir, 'footage', 'a.mp4'));
  });
});

describe('Guide render', () => {
  it('renders a vertical Short of the planned length from widescreen footage, with no voice yet', { timeout: 240_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guide-'));
    try {
      await fs.mkdir(path.join(dir, 'footage'));
      const make = (name: string, sound: boolean) =>
        run('ffmpeg', [
          '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=10',
          ...(sound ? ['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=10', '-c:a', 'aac'] : []),
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(sound ? ['-shortest'] : []), path.join(dir, 'footage', name),
        ]);
      await make('opener.mp4', true);
      await make('1.mp4', false);
      await make('2.mp4', true);
      const p = guide({ whooshes: false });
      const out = await renderGuide(dir, p);
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', path.join(dir, out.video)]);
      const info = JSON.parse(stdout);
      const video = info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
      assert.deepEqual([video.width, video.height], [1080, 1920]);
      assert.ok(info.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'));
      assert.ok(Math.abs(Number(info.format.duration) - out.durationSec) < 0.15, `${info.format.duration} vs ${out.durationSec}`);
      assert.equal(toFrames(out.durationSec), Math.round(out.durationSec * 30));
      assert.match(out.warnings.join(' '), /no narrator/);
      assert.match(out.warnings.join(' '), /soft/);
      assert.ok((await fs.stat(path.join(dir, out.thumbnail))).size > 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('renders a wide video with a still picture, a side-by-side shot, a chapter card and a note', { timeout: 240_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guide-wide-'));
    try {
      await fs.mkdir(path.join(dir, 'footage'));
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=10', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=10', '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', path.join(dir, 'footage', 'a.mp4')]);
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'footage', 'v.mp4')]);
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x480:d=1', '-frames:v', '1', path.join(dir, 'footage', 'pic.jpg')]);
      const p = guide({
        format: 'wide',
        gapSec: 0.4,
        whooshes: false,
        titleCard: '',
        loopLine: '',
        opener: { file: 'footage/a.mp4', from: 1, to: 3 },
        items: [
          { heading: '2002 · VICE CITY', note: 'KEY LENTO', say: 'One two three four five six seven eight.', shots: [{ file: 'footage/pic.jpg', from: 0, to: 0.04, push: 0.1 }, { file: 'footage/a.mp4', from: 3, to: 6, beside: { file: 'footage/v.mp4', from: 0, to: 4 }, labels: ['2002', 'GTA 6'] }] },
          { heading: '', say: 'And more words here.', shots: [{ file: 'footage/v.mp4', from: 1, to: 4, volume: 1 }] },
        ],
        outroShots: [{ file: 'footage/a.mp4', from: 7, to: 9 }],
      });
      const out = await renderGuide(dir, p);
      assert.equal(out.video, 'export/video.mp4');
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', path.join(dir, out.video)]);
      const info = JSON.parse(stdout);
      const video = info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
      assert.deepEqual([video.width, video.height], [1920, 1080]);
      assert.ok(Math.abs(Number(info.format.duration) - out.durationSec) < 0.15, `${info.format.duration} vs ${out.durationSec}`);
      assert.doesNotMatch(out.warnings.join(' '), /soft/);
      // A second render reuses the footage it already made
      const parts = (await fs.readdir(path.join(dir, 'render-base'))).filter((f) => f.startsWith('part-'));
      await renderGuide(dir, p);
      assert.deepEqual((await fs.readdir(path.join(dir, 'render-base'))).filter((f) => f.startsWith('part-')), parts);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Guide voice tags', () => {
  it('keeps [tags] out of captions, and gives them only to a voice that acts them out', () => {
    const line = '[softly] Now we *know*. [whispers] He never ~did~. [dramatic pause] Right.';
    assert.deepEqual(parseMarkup(line).words.map((w) => w.word), ['Now', 'we', 'know.', 'He', 'never', 'did.', 'Right.']);
    assert.equal(parseMarkup(line).words[2].colour, 'green');
    assert.equal(voiceText(line, false), 'Now we know. He never did. Right.');
    assert.equal(voiceText(line, true), '[softly] Now we know. [whispers] He never did. [dramatic pause] Right.');
  });
});

describe('Guide wide layout', () => {
  it('crops to a wide window, carries a side-by-side partner onto each cut, and skips cards for items with no heading', () => {
    assert.deepEqual(cropFor({ width: 720, height: 1280 }, 0.5, 1, 0.3, 16 / 9), { w: 720, h: 404, x: 0, y: 182 });
    const cuts = fillCuts([{ file: 'a.mp4', from: 10, to: 16, beside: { file: 'b.mp4', from: 0, to: 20 }, labels: ['THEN', 'NOW'] }], 4, 2);
    assert.ok(cuts.every((c) => c.beside?.file === 'b.mp4' && c.labels?.[1] === 'NOW'));
    assert.ok(cuts.every((c) => Math.abs(c.beside!.from - (c.from - 10)) < 0.01 && c.beside!.srcSec === c.srcSec));
    const p = guide({ items: [{ heading: 'A', say: 'One two.', shots: [] }, { heading: '', say: 'Three four.', shots: [] }] });
    const plan = planGuide(p, () => 1);
    assert.deepEqual(cardWindows(plan.segments, p.items).map((c) => c.itemIndex), [0]);
    assert.equal(cardWindows(plan.segments).length, 2);
  });

  it('lists chapters YouTube accepts: from 0:00, ten seconds or more apart, only with three or more', () => {
    const items = ['2002 · Vice City', '', 'Title | Card', '2004 · San Andreas', 'The Door'].map((heading, i) => ({ heading, say: 'x', shots: [], ...(i === 2 ? { chapter: false as const } : {}) }));
    const segs = [0, 5, 30, 34, 50, 90].map((start, i) => (i === 0 ? { part: 'hook', kind: 'hook' as const, start, durationSec: 5, cuts: [] } : { part: `item-${i - 1}`, kind: 'item' as const, itemIndex: i - 1, start, durationSec: 4, cuts: [] }));
    const ch = chapterList({ items, introChapter: 'The door' }, segs);
    assert.deepEqual(ch.map((c) => [c.at, c.title]), [[0, 'The door'], [50, '2004 · San Andreas'], [90, 'The Door']]);
    assert.deepEqual(chapterList({ items: items.slice(0, 1) }, segs.slice(0, 2)), []);
    assert.deepEqual([clockTime(75.4), clockTime(3725)], ['1:15', '1:02:05']);
  });

  it('adds a tail with no voice after the last line (room for the end screen)', () => {
    const a = planGuide(guide({}), () => 1).durationSec;
    const b = planGuide(guide({ tailSec: 15 }), () => 1).durationSec;
    assert.ok(Math.abs(b - a - 15) < 0.05);
  });

  it('leaves a longer gap between lines when asked', () => {
    const a = planGuide(guide({}), () => 1).durationSec;
    const b = planGuide(guide({ gapSec: 0.5 }), () => 1).durationSec;
    assert.ok(b > a);
  });
});

describe('Guide motion graphics', () => {
  it('finds the end of a CONFIG object past strings, comments and nested braces', () => {
    const src = 'x; const CONFIG = { a: "}", b: { c: `{`, d: [1, 2] }, // } here\n e: /* } */ 1 }; after';
    const open = src.indexOf('{');
    assert.equal(src.slice(objectEnd(src, open) + 1), '; after');
  });

  it("passes the page's CONFIG through our changes and points its video players at our clip", () => {
    const html = '<video id="p0a" class="clip" src="assets/shots/a.mp4" muted data-start="2.25" data-duration="1" data-media-start="0.3"></video>\n<script>const CONFIG = { word: "Wasted", t: { hit: 1.2 } };\nrun(CONFIG);</script>';
    const out = patchComponent(html, { ids: ['p0a'], src: 'assets/shots/ours.webm' });
    assert.match(out, /const CONFIG = window\.__gcMerge\(\{ word: "Wasted", t: \{ hit: 1\.2 \} \}, window\.__gcOverride \|\| \{\}\);\nrun\(CONFIG\)/);
    // One continuous clip: each player starts where its slot on the timeline does
    assert.match(out, /<video id="p0a" class="clip" src="assets\/shots\/ours\.webm" muted data-start="2\.25" data-duration="1" data-media-start="2\.25">/);
    assert.throws(() => patchComponent('<p>no config</p>'), /no CONFIG/);
    const init = initScript({ variant: '1', config: { word: 'Busted' } });
    assert.match(init, /getVariables: function \(\) \{ return \{"variant":"1","bg":"none"\}; \}/);
    assert.match(init, /window\.__gcOverride = \{"word":"Busted"\};/);
    assert.match(initScript({ plate: true }), /"bg":"plate"/);
  });

  it('levels the music and ducks it and the game under the narrator', () => {
    const g = guideMixGraph({ durationSec: 10, voices: [{ input: 3, atSec: 0 }, { input: 4, atSec: 2.5 }], sfx: [{ input: 6, atSec: 1, volume: 0.4 }], music: { input: 5, volume: 1 } });
    assert.match(g, /\[4:a\][^;]*adelay=2500\|2500[^;]*\[vo1\]/);
    assert.match(g, /\[vo0\]\[vo1\]amix=inputs=2[^;]*asplit=3\[voice\]\[key1\]\[key2\]/);
    // The music is levelled first (a track that swells stays put), then ducks under the voice
    assert.match(g, /\[5:a\][^;]*loudnorm=I=-27:LRA=3[^;]*\[m0\];\[m0\]\[key2\]sidechaincompress[^;]*\[music\]/);
    assert.match(g, /\[g0\]\[key1\]sidechaincompress[^;]*\[game\]/);
    assert.match(g, /\[voice\]\[game\]\[music\]\[fx0\]amix=inputs=4/);
    // No music, no voice: still a valid graph
    const bare = guideMixGraph({ durationSec: 3, voices: [], sfx: [] });
    // Only the copies of the voice that are used (an unused one into anullsink stalls ffmpeg)
    assert.match(bare, /anullsrc[^;]*asplit=2\[voice\]\[key1\]/);
    assert.ok(!bare.includes('anullsink') && !bare.includes('key2'));
    assert.match(bare, /\[voice\]\[game\]amix=inputs=2/);
  });

  it('fits each graphic to its length, under the guide changes', () => {
    assert.deepEqual(mergeConfig({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] }, e: null }), { a: { b: 1, c: [2] }, d: 1, e: null });
    const wasted = motionConfig('wasted', 2.2) as { timing: { hit: number; out: number; close: number }; variants: Record<string, { kicker: unknown }> };
    assert.equal(wasted.timing.hit, 0.12);
    assert.equal(wasted.timing.out, 1.75);
    assert.ok(wasted.timing.close > 2.2, 'it never shuts to black inside the window');
    assert.equal(wasted.variants['0'].kicker, null);
    const loc = motionConfig('location', 2.6, { variants: { '0': { lines: ['Pelican', 'River'] } } }) as { timing: { end0: number }; variants: Record<string, { lines: string[] }> };
    assert.equal(loc.timing.end0, 2.6);
    assert.deepEqual(loc.variants['0'].lines, ['Pelican', 'River']);
  });

  it('pins shots to set lengths and shares the rest, and places graphics on the item clock', () => {
    const cuts = fillCuts([{ file: 'a', from: 0, to: 5, sec: 2 }, { file: 'b', from: 0, to: 9 }, { file: 'c', from: 10, to: 16, sec: 3 }], 8, 1.5);
    assert.deepEqual([cuts[0].file, cuts[0].outSec, cuts[0].srcSec], ['a', 2, 2]);
    assert.deepEqual([cuts[cuts.length - 1].file, cuts[cuts.length - 1].from, cuts[cuts.length - 1].outSec], ['c', 10, 3]);
    assert.equal(cuts.reduce((a, c) => a + toFrames(c.outSec), 0), 240);
    assert.ok(cuts.slice(1, -1).every((c) => c.file === 'b'));
    // A sliver with a set length is a freeze-frame, kept (with its push and sound); a bare sliver is skipped
    const freeze = fillCuts([{ file: 'b', from: 0, to: 6 }, { file: 'f', from: 3, to: 3.04, sec: 1.5, push: 0.15, sound: 'dark impact' }, { file: 'x', from: 1, to: 1.02 }], 4, 1.5);
    const last = freeze[freeze.length - 1];
    assert.deepEqual([last.file, last.srcSec, last.outSec, last.push, last.sound], ['f', 0.04, 1.5, 0.15, 'dark impact']);
    assert.ok(!freeze.some((c) => c.file === 'x'));
    // A muted shot (a streamer talking) keeps its mute on every cut
    const muted = fillCuts([{ file: 's', from: 0, to: 9, mute: true }], 4, 1.5);
    assert.ok(muted.length > 1 && muted.every((c) => c.mute === true));
    assert.ok(fillCuts([{ file: 's', from: 0, to: 9 }], 4, 1.5).every((c) => c.mute === undefined));

    const p = guide({
      items: [
        { heading: 'One', say: 'One.', shots: [{ file: 'footage/1.mp4', from: 0, to: 9 }], after: 1, motion: [{ kind: 'wasted', at: -2.2 }, { kind: 'location', at: 0.5 }] },
        { heading: 'Two', say: 'Two.', shots: [{ file: 'footage/2.mp4', from: 0, to: 9 }] },
      ],
    });
    const { segments } = planGuide(p, () => 3);
    // The item has its extra second
    assert.equal(segments[1].durationSec, 4.133);
    const w = motionWindows(p, segments);
    assert.deepEqual(w.map((x) => [x.motion.kind, x.from, x.to]), [
      ['wasted', Number((segments[1].start + 4.133 - 2.2).toFixed(3)), Number((segments[1].start + 4.133).toFixed(3))],
      ['location', Number((segments[1].start + 0.5).toFixed(3)), Number((segments[1].start + 3.1).toFixed(3))],
    ]);
  });
});
