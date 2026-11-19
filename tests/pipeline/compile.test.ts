import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matches, orderClips, pickForTheme, suggestThemes, themeName, trimToBudget } from '../../src/pipeline/compile/select.ts';
import { buildCompilationPrompt, fallbackScript } from '../../src/pipeline/compile/script.ts';
import { assText, clipAudioFilter, frameFilter, overlayAss } from '../../src/pipeline/compile/render.ts';
import { composeCompilationDescription, creditsBlock } from '../../src/pipeline/compile/package.ts';
import { fitShortItems, itemFromLibrary } from '../../src/pipeline/compile/run.ts';
import type { Compilation, LibraryItem } from '../../src/pipeline/compile/types.ts';

let n = 0;
const lib = (over: Partial<LibraryItem> = {}): LibraryItem => ({
  key: `hunt:h:m${n++}`,
  kind: 'moment',
  title: 'A moment',
  description: 'Something happens.',
  recipe: 'funny',
  score: 7,
  creator: '@a',
  platform: 'YouTube',
  pageUrl: 'https://www.youtube.com/watch?v=x&t=10',
  file: 'C:/x.mp4',
  start: 0,
  end: 30,
  thumb: null,
  transcript: '',
  createdAt: '2026-11-18T00:00:00Z',
  usedIn: [],
  ...over,
});

const comp = (over: Partial<Compilation> = {}): Compilation => ({
  id: '20261119-abcdef12',
  format: 'short',
  title: '',
  theme: 'Funniest GTA 6 moments',
  items: [],
  hook: '',
  intro: '',
  outro: '',
  titles: [],
  description: '',
  tags: [],
  options: { captions: true, cleanCaptions: true, nameCards: true, voiceover: false, crop: true, voice: '' },
  createdAt: '',
  updatedAt: '',
  status: 'draft',
  step: '',
  warnings: [],
  analysis: {},
  voice: {},
  ...over,
});

describe('choosing clips', () => {
  it('filters by kind, streamer, age and use', () => {
    const now = Date.parse('2026-11-19T00:00:00Z');
    assert.ok(matches(lib(), { recipes: ['funny'] }, now));
    assert.ok(!matches(lib(), { recipes: ['chase'] }, now));
    assert.ok(matches(lib({ creator: '@Lemon' }), { creator: '@lemon' }, now));
    assert.ok(!matches(lib({ createdAt: '2026-11-01T00:00:00Z' }), { sinceDays: 7 }, now));
    assert.ok(!matches(lib({ usedIn: ['c1'] }), { unusedOnly: true }, now));
  });

  it('suggests themes only when there are enough unused clips', () => {
    const items = [lib(), lib(), lib(), lib({ recipe: 'chase' }), lib({ recipe: 'chase', usedIn: ['c'] })];
    const names = suggestThemes(items).map((t) => t.name);
    assert.ok(names.includes('Funniest GTA 6 moments'));
    assert.ok(!names.includes('Best police chases'));
    assert.equal(themeName({ recipes: ['crash'] }), 'Craziest crashes and chaos');
  });

  it('takes the best clips but lets no streamer take more than half', () => {
    const items = [lib({ score: 10, creator: '@a' }), lib({ score: 9, creator: '@a' }), lib({ score: 9, creator: '@a' }), lib({ score: 5, creator: '@b' })];
    const picked = pickForTheme(items, {}, 4);
    assert.equal(picked.length, 4);
    const four = pickForTheme(items, {}, 2);
    assert.deepEqual(four.map((i) => i.creator).sort(), ['@a', '@b']);
  });

  it('opens with the second best, ends with the best, and spreads streamers out', () => {
    const order = orderClips([
      { score: 9, creator: '@a', id: 'best' },
      { score: 8, creator: '@a', id: 'second' },
      { score: 6, creator: '@a', id: 'x' },
      { score: 5, creator: '@b', id: 'y' },
    ]);
    assert.equal(order[0].id, 'second');
    assert.equal(order[order.length - 1].id, 'best');
    assert.equal(order[1].creator, '@b');
    assert.deepEqual(orderClips([{ score: 9, creator: 'a' }, { score: 5, creator: 'b' }]).map((x) => x.score), [5, 9]);
  });

  it('cuts a long clip around its loudest moment, mostly before it', () => {
    assert.deepEqual(trimToBudget({ start: 0, end: 10 }, 5, 14), { start: 0, end: 10 });
    assert.deepEqual(trimToBudget({ start: 0, end: 40 }, 20, 10), { start: 13.5, end: 23.5 });
    assert.deepEqual(trimToBudget({ start: 0, end: 40 }, 2, 10), { start: 0, end: 10 });
    assert.deepEqual(trimToBudget({ start: 0, end: 40 }, 39, 10), { start: 30, end: 40 });
  });

  it('shares a Short\'s minute between its clips', () => {
    const items = [lib(), lib(), lib(), lib()].map(itemFromLibrary);
    const c = comp({ items, analysis: Object.fromEntries(items.map((it) => [it.key, { durationSec: 30, width: 1920, height: 1080, hasAudio: true, peakSec: 20, words: [] }])) });
    const fitted = fitShortItems(c);
    const total = fitted.reduce((s, it) => s + it.end - it.start, 0);
    assert.ok(total <= 58.5, `total ${total}`);
    assert.ok(fitted.every((it) => it.start <= 20 && it.end >= 20));
  });
});

describe('compilation script', () => {
  const items = [itemFromLibrary(lib({ title: 'Bike bail' })), itemFromLibrary(lib({ title: 'Plane crash' }))];

  it('numbers the countdown from the top for the writer', () => {
    const prompt = buildCompilationPrompt({ format: 'long', theme: 'Best crashes', items });
    assert.match(prompt, /CLIP 0 \(shown as #2\): Bike bail/);
    assert.match(prompt, /CLIP 1 \(shown as #1\): Plane crash/);
  });

  it('has a plain fallback with numbered lines', () => {
    const s = fallbackScript({ format: 'long', theme: 'Best crashes', items });
    assert.equal(s.items[0].line, 'Number 2: Something happens.');
    assert.equal(s.items[1].label, 'Plane crash');
  });
});

describe('render pieces', () => {
  it('keeps card text safe for the subtitle renderer', () => {
    assert.equal(assText('Wow {\\b1} 🔥 next'), 'Wow b1 next');
    assert.equal(assText('line one\nline two'), 'line one\\Nline two');
    const ass = overlayAss(1920, 1080, [{ style: 'CardBig', text: '#5', startMs: 0, endMs: 2000 }, { style: 'Tag', text: '', startMs: 0, endMs: 100 }]);
    assert.match(ass, /PlayResX: 1920/);
    assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:02\.00,CardBig,,0,0,0,,\{\\fad\(150,150\)\}#5/);
    assert.equal(ass.match(/^Dialogue/gm)?.length, 1);
  });

  it('crops or fits the picture to the canvas', () => {
    assert.match(frameFilter('[0:v]', 1080, 1920, true, '[fr]'), /crop=1080:1920,setsar=1\[fr\]$/);
    assert.match(frameFilter('[0:v]', 1920, 1080, false, '[fr]'), /gblur.*overlay/);
  });

  it('evens out each clip\'s sound and adds a whoosh at the cut', () => {
    assert.match(clipAudioFilter(true, 10, 1), /loudnorm.*amix=inputs=2/);
    assert.match(clipAudioFilter(false, 10, null), /^anullsrc/);
  });
});

describe('credits', () => {
  it('credits every streamer, in countdown order for long form', () => {
    const items = [itemFromLibrary(lib({ creator: '@a' })), itemFromLibrary(lib({ creator: '@b', pageUrl: 'https://x.com/b/status/1' }))].map((it, i) => ({ ...it, label: `Clip ${i}` }));
    const c = comp({ format: 'long', items, description: 'Two clips.', tags: ['gta 6 crashes'] });
    assert.equal(creditsBlock(c), '#2 Clip 0 by @a: https://www.youtube.com/watch?v=x&t=10\n#1 Clip 1 by @b: https://x.com/b/status/1');
    assert.match(composeCompilationDescription(c), /^Two clips\.\n\nClips featured:\n#2 .*\n\n#GTA6 #GTA6Crashes$/s);
    assert.match(composeCompilationDescription(comp({ items, tags: [] })), /#Shorts #GTA6$/);
  });
});
