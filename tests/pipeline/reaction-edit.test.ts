import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fitCutIns, fitEffects, fitHeader, flashFilter, headerHtml, headerY, joinGraph, outputTime, parts, shakeFilter, shortDuration, timeline } from '../../src/pipeline/clipping/reaction.ts';
import { libraryMatches, memeKey, prepareMemes, searchGiphy } from '../../src/pipeline/clipping/memes.ts';
import { renderReactionShort } from '../../src/pipeline/clipping/reaction-render.ts';
import { captionTrack, layoutBase } from '../../src/pipeline/clipping/render.ts';
import { buildScriptPrompt, planFromDraft, type ScriptDraft } from '../../src/pipeline/clipping/script.ts';
import type { ClipAnalysis, ClipPlan, ClipProject, CutIn } from '../../src/pipeline/clipping/types.ts';

const run = promisify(execFile);

const analysis = (over: Partial<ClipAnalysis> = {}): ClipAnalysis => ({
  durationSec: 30, width: 1920, height: 1080, hasAudio: true, loudness: [], peaks: [{ at: 12, score: 9 }],
  words: [], transcript: '', musicSections: [], frames: [], ...over,
});
const project = (over: Partial<ClipProject> = {}): ClipProject => ({
  id: '20261123-abcdef12', sourceUrl: 'https://x.com/a/status/1', creator: '', note: 'NPC fights back',
  createdAt: '2026-11-23T00:00:00Z', updatedAt: '2026-11-23T00:00:00Z', status: 'ready', step: 'Ready', warnings: [], ...over,
});
const draft = (over: Partial<ScriptDraft> = {}): ScriptDraft => ({
  summary: 'x', peakSec: 12, trimStart: 4, trimEnd: 24, layout: 'fit', hook: 'He had no idea', overlays: [], voiceLines: [],
  titles: ['t'], description: 'd', tags: ['gta 6'], ...over,
});

describe('Reaction edit rules', () => {
  it('keeps memes off the build-up, one freeze before the peak, and spaces cut-ins out', () => {
    const c = fitCutIns({ memes: [{ at: 11.5, query: 'its working' }, { at: 18, query: 'bro got me' }, { at: 18.5, query: 'too close' }, { at: 21, query: 'third' }], freezeAt: 9, replay: true }, 4, 24, 12);
    assert.deepEqual(c.map((x) => [x.kind, x.at]), [['freeze', 9], ['replay', 13], ['meme', 13], ['meme', 18]]);
    assert.deepEqual(fitCutIns({ memes: [{ at: 11.5, query: 'x' }] }, 4, 24, 12).map((x) => x.at), [12.4], 'no replay: just after the payoff');
    assert.equal(c.find((x) => x.kind === 'replay')!.durationSec, 2.4);
  });

  it('moves a freeze placed after the peak to just before it, and drops an empty meme', () => {
    const c = fitCutIns({ memes: [{ at: 15, query: '  ' }], freezeAt: 20 }, 0, 30, 12);
    assert.deepEqual(c.map((x) => [x.kind, x.at]), [['freeze', 11.7]]);
  });

  it('puts a flash and shake on the big moment and spaces extra hits', () => {
    assert.deepEqual(fitEffects([{ at: 12.3, kind: 'flash' }, { at: 16, kind: 'shake' }, { at: 40, kind: 'shake' }], 4, 24, 12), [
      { at: 12, kind: 'flash' }, { at: 12, kind: 'shake' }, { at: 16, kind: 'shake' },
    ]);
  });

  it('keeps only red words that are in the header', () => {
    assert.deepEqual(fitHeader({ text: 'NPCs have ZERO chill 😭✌️', highlight: ['zero', 'missing'] }, 'hook'), { text: 'NPCs have ZERO chill 😭✌️', highlight: ['zero'] });
    assert.equal(fitHeader(undefined, 'From the hook').text, 'From the hook');
    assert.equal(headerHtml({ text: 'NPCs have ZERO chill <3', highlight: ['ZERO'] }), 'NPCs have <span class="hl">ZERO</span> chill &lt;3');
  });

  it('new clips get the reaction edit; older clips keep theirs', () => {
    const plan = planFromDraft(draft({ header: { text: 'bro thought 💀', highlight: ['bro'] }, memes: [{ at: 14, query: 'its working' }], freezeAt: 10, voiceLines: [{ at: 10.1, text: 'wait look at him', slot: 'build' }] }), project(), analysis());
    assert.equal(plan.editStyle, 'reaction');
    assert.equal(plan.header?.text, 'bro thought 💀');
    assert.deepEqual(plan.cutIns?.map((c) => c.kind), ['freeze', 'meme']);
    // The freeze's line needs no quiet gap (the clip has no gaps listed here) and sits on the freeze
    assert.deepEqual(plan.voiceLines.map((l) => [l.at, l.text]), [[10, 'wait look at him']]);
    assert.equal(plan.sfxOnPeak, true);
    const classic = { ...plan, editStyle: undefined } as ClipPlan;
    const again = planFromDraft(draft(), project(), analysis(), classic);
    assert.equal(again.editStyle, 'classic');
    assert.equal(again.cutIns, undefined);
    assert.match(buildScriptPrompt(project(), analysis(), 'hype', [], undefined, 'reaction'), /REACTION EDIT/);
    assert.doesNotMatch(buildScriptPrompt(project(), analysis(), 'hype', []), /REACTION EDIT/);
  });
});

describe('Reaction edit timeline', () => {
  const meme = { file: 'memes/m.mp4', source: 'library' as const, title: 'm', origin: 'm.mp4', hasAudio: false, durationSec: 3, key: 'm|0' };
  const plan = (cutIns: CutIn[], over: Partial<ClipPlan> = {}) => ({ cutIns, trimStart: 4, trimEnd: 24, voiceLines: [], voiceover: true, ...over });

  it('pushes later moments back by each cut-in before them', () => {
    const { cutIns } = timeline(plan([{ kind: 'freeze', at: 9, durationSec: 1.6 }, { kind: 'meme', at: 14, durationSec: 1.4, query: 'm', meme }]));
    assert.equal(outputTime(9, 4, cutIns), 5, 'a moment at a freeze lands at its start');
    assert.equal(outputTime(10, 4, cutIns), 7.6);
    assert.equal(outputTime(20, 4, cutIns), 19);
    assert.equal(shortDuration(20, cutIns), 23);
  });

  it('stretches a freeze to its voice line and drops memes nothing was found for', () => {
    const t = timeline(plan([{ kind: 'freeze', at: 9, durationSec: 1.6 }, { kind: 'meme', at: 14, durationSec: 1.4, query: 'm' }], { voiceLines: [{ at: 9.2, text: 'wait', slot: 'build', durationSec: 2.5, audioFile: 'v.wav' }] }));
    // 0.45 s for the record scratch, then the 2.5 s line, then a breath
    assert.deepEqual(t.cutIns.map((c) => [c.kind, c.durationSec]), [['freeze', 3.3]]);
    assert.equal(t.voiceLines[0].at, 9);
    assert.equal(t.voiceLines[0].offsetSec, 0.45, 'the line waits for the scratch');
  });

  it('cuts the clip into pieces with the cut-ins between them', () => {
    const { cutIns } = timeline(plan([{ kind: 'freeze', at: 9, durationSec: 1.6 }, { kind: 'replay', at: 13, durationSec: 2.4, replaySec: 1.2 }, { kind: 'meme', at: 16, durationSec: 1.4, query: 'm', meme }]));
    const memeInputs = new Map(cutIns.filter((c) => c.kind === 'meme').map((c) => [c, 1]));
    const ps = parts(20, cutIns, memeInputs);
    assert.deepEqual(ps, [
      { kind: 'clip', from: 0, to: 5, holdSec: 1.6 },
      { kind: 'clip', from: 5, to: 9, holdSec: 0 },
      { kind: 'replay', from: 7.8, to: 9 },
      { kind: 'clip', from: 9, to: 12, holdSec: 0 },
      { kind: 'meme', input: 1, durationSec: 1.4, hasAudio: false },
      { kind: 'clip', from: 12, to: 20, holdSec: 0 },
    ]);
    const graph = joinGraph({ base: layoutBase('fit'), parts: ps, hasAudio: true, clipSec: 20, muteExpr: '1', fps: 30 });
    assert.match(graph, /tpad=stop_mode=clone:stop_duration=1\.600/);
    assert.match(graph, /setpts=2\.000\*\(PTS-STARTPTS\)/);
    assert.match(graph, /atempo=0\.5/);
    assert.match(graph, /concat=n=6:v=1:a=1\[cv\]\[ca\]/);
    assert.match(shakeFilter([3])!, /crop=w=iw-36/);
    assert.match(flashFilter([3])!, /color=red@0\.42.*between\(t,3\.000,3\.070\)/);
    assert.equal(shakeFilter([]), null);
  });

  it('times captions on the Short’s clock and hides the hook under a header', () => {
    const p = planFromDraft(draft(), project(), analysis({ words: [{ word: 'run', start: 15, end: 15.3 }] }));
    const { cutIns } = timeline(plan([{ kind: 'freeze', at: 9, durationSec: 2 }]));
    const track = captionTrack(p, analysis({ words: [{ word: 'run', start: 15, end: 15.3 }] }), { map: (s) => outputTime(s, 4, cutIns), durationSec: 22, hideHook: true });
    assert.deepEqual(track.words.map((w) => [w.word, w.start, Number(w.end.toFixed(2))]), [['run', 13, 13.3]]);
    assert.equal(track.banners.length, 0);
  });

  it('puts the header just above a landscape clip, near the top otherwise', () => {
    assert.equal(headerY('fit', 1920, 1080, 250), 388);
    assert.equal(headerY('crop', 1920, 1080, 250), 230);
    assert.equal(headerY('original', 1080, 1920, 250), 230);
  });
});

describe('Finding memes', () => {
  it('matches library files by the words in their names', () => {
    const files = ['its-working.mp4', path.join('shocked', 'guy 1.gif'), 'bro got me.mp4', 'random.mp4'];
    assert.deepEqual(libraryMatches(files, "it's working"), ['its-working.mp4']);
    assert.deepEqual(libraryMatches(files, 'shocked guy'), [path.join('shocked', 'guy 1.gif')]);
    assert.deepEqual(libraryMatches(files, 'bro got me meme'), ['bro got me.mp4']);
    assert.deepEqual(libraryMatches(files, 'meme'), []);
    assert.equal(memeKey({ query: ' Its Working ', pick: 2 }), 'its working|2');
  });

  it('reads GIPHY results', async () => {
    const fake = (async () => new Response(JSON.stringify({ data: [{ title: 'Working', url: 'https://giphy.com/x', images: { original: { mp4: 'https://media.giphy.com/x.mp4' } } }, { title: 'no mp4', images: {} }] }))) as unknown as typeof fetch;
    assert.deepEqual(await searchGiphy('its working', 'k', fake), [{ source: 'giphy', title: 'Working', location: 'https://media.giphy.com/x.mp4', origin: 'https://giphy.com/x' }]);
  });

  it('renders a reaction Short with a header, a freeze, a replay and a library meme', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reaction-'));
    try {
      const lib = path.join(root, 'lib');
      const dir = path.join(root, 'clip');
      await fs.mkdir(lib, { recursive: true });
      await fs.mkdir(dir, { recursive: true });
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=8', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'source.mp4')]);
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=320x240:r=15:d=0.8', path.join(lib, 'its-working.gif')]);

      const env = { MEME_LIBRARY_DIR: lib };
      const found = await prepareMemes(dir, [{ kind: 'meme', at: 5, durationSec: 1.4, query: "it's working", pick: 0 }], env);
      assert.deepEqual(found.warnings, []);
      assert.equal(found.cutIns[0].meme?.source, 'library');
      assert.equal(found.cutIns[0].meme?.hasAudio, false);
      // Found again only when the query or pick changes
      const again = await prepareMemes(dir, found.cutIns, env);
      assert.equal(again.cutIns[0].meme?.file, found.cutIns[0].meme?.file);
      const none = await prepareMemes(dir, [{ kind: 'meme', at: 5, durationSec: 1.4, query: 'nothing like this', pick: 0 }], env);
      assert.equal(none.cutIns[0].meme, undefined);
      assert.match(none.warnings[0], /No meme found/);

      const plan = planFromDraft(draft({ peakSec: 4, trimStart: 0, trimEnd: 8, header: { text: 'He really thought 💀', highlight: ['really'] } }), project(), analysis({ durationSec: 8, width: 640, height: 360, peaks: [{ at: 4, score: 5 }] }));
      plan.cutIns = [{ kind: 'freeze', at: 2, durationSec: 1 }, { kind: 'replay', at: 4.6, durationSec: 1.6, replaySec: 0.8 }, found.cutIns[0]];
      plan.captions = false;
      const out = await renderReactionShort(dir, 'source.mp4', plan, analysis({ durationSec: 8, width: 640, height: 360, words: [], peaks: [] }));

      const memeSec = Math.max(0.8, Math.min(1.4, found.cutIns[0].meme!.durationSec));
      const expected = 8 + 1 + 1.6 + memeSec;
      assert.ok(Math.abs(out.durationSec - expected) < 0.05, `Short is ${out.durationSec}s, expected ${expected}`);
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', path.join(dir, out.video)]);
      const info = JSON.parse(stdout) as { streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { duration: string } };
      assert.deepEqual(info.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
      assert.equal(info.streams.find((s) => s.codec_type === 'video')?.height, 1920);
      assert.ok(Math.abs(Number(info.format.duration) - expected) < 0.15, `file runs ${info.format.duration}s`);
      await fs.access(path.join(dir, out.thumbnail));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('Captions around memes', () => {
  it('cuts a phrase off when a meme starts and shows none during it', async () => {
    const { generateAssCaptions } = await import('../../src/pipeline/assembly/captions.ts');
    const words = [{ word: 'No!!', start: 1, end: 1.3 }, { word: 'during', start: 2.2, end: 2.5 }, { word: 'after', start: 4, end: 4.3 }];
    const base = { beats: [{ index: 0, text: '' }], units: [{ unit_index: 0, duration_ms: 6000 }], beatStartMs: [0], words: { 0: words }, preset: 'social_pop' as const, resolution: { width: 1080, height: 1920 } };
    const lines = (ass: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue:')).map((l) => l.split(',').slice(1, 3).join('-') + ' ' + l.split(',,').pop()!.replace(/\{[^}]*\}/g, ''));
    const quiet = lines(generateAssCaptions({ ...base, quiet: [{ startMs: 1500, endMs: 3000 }] }).assContent);
    assert.deepEqual(quiet, ['0:00:01.00-0:00:01.50 NO!!', '0:00:04.00-0:00:04.80 AFTER']);
    assert.equal(lines(generateAssCaptions(base).assContent).length, 3);
  });
});

describe('Ramps, endings, emoji, sounds and loops', () => {
  it('ramps into the big moment and keeps a freeze clear of the slowed stretch', async () => {
    const { fitCutIns: fit } = await import('../../src/pipeline/clipping/reaction.ts');
    const c = fit({ ramp: true, freezeAt: 11.8, freezeFocus: { x: 0.3, y: 1.4 }, memes: [{ at: 12.2, query: 'its working' }] }, 4, 24, 12);
    assert.deepEqual(c.map((x) => [x.kind, x.at]), [['freeze', 10.9], ['ramp', 12], ['meme', 12.4]]);
    assert.deepEqual(c[0].focus, { x: 0.3, y: 1 });
    assert.equal(c[1].durationSec, 0.8);
  });

  it('stretches moments inside a ramp and pushes later ones by its extra time', async () => {
    const { outputTime: out, timeline: tl, parts: ps, joinGraph: jg } = await import('../../src/pipeline/clipping/reaction.ts');
    const { cutIns } = tl({ cutIns: [{ kind: 'ramp', at: 12, durationSec: 0.8, replaySec: 0.8 }], trimStart: 4, trimEnd: 24, voiceLines: [], voiceover: true });
    assert.equal(cutIns[0].outAt, 7.2);
    assert.ok(Math.abs(out(11.2, 4, cutIns) - 7.2) < 1e-9);
    assert.ok(Math.abs(out(11.6, 4, cutIns) - 8) < 1e-9, 'half-way through the ramp is 0.8 s in');
    assert.equal(out(12, 4, cutIns), 8.8);
    assert.equal(out(20, 4, cutIns), 16.8);
    const parts = ps(20, cutIns, new Map(), 2);
    assert.deepEqual(parts, [
      { kind: 'clip', from: 0, to: 7.2, holdSec: 0 },
      { kind: 'ramp', from: 7.2, to: 8 },
      { kind: 'clip', from: 8, to: 20, holdSec: 2 },
    ]);
    assert.match(jg({ base: layoutBase('crop'), parts, hasAudio: true, clipSec: 20, muteExpr: '1', fps: 30 }), /asetrate=24000,aresample=48000/);
  });

  it('keeps valid emoji and sounds, and fills in an ending’s defaults', async () => {
    const { fitEffects: fe, fitEnding, endingFilter, framePoint, zoomWindow } = await import('../../src/pipeline/clipping/reaction.ts');
    assert.deepEqual(
      fe([{ at: 13, kind: 'emoji', emoji: '💀' }, { at: 14, kind: 'emoji', emoji: '!!' }, { at: 15, kind: 'sound', query: ' vine  boom ' }, { at: 16, kind: 'sound' }], 4, 24, null),
      [{ at: 13, kind: 'emoji', emoji: '💀' }, { at: 15, kind: 'sound', query: 'vine boom' }],
    );
    assert.deepEqual(fitEnding({ style: 'stamp' }), { style: 'stamp', text: 'SKILL ISSUE', query: 'vine boom', durationSec: 2 });
    assert.equal(fitEnding({ style: 'credits', text: 'Directed by\nLUCIA' })?.text, 'Directed by\nLUCIA');
    assert.equal(fitEnding({ style: 'none' }), undefined);
    assert.match(endingFilter('tbc', 10, 12.6)!, /colorchannelmixer=\.393.*between\(t,10\.000,12\.600\)/);
    assert.match(endingFilter('stamp', 10, 12)!, /hue=s=0/);
    assert.deepEqual(framePoint('fit', 1920, 1080, { x: 0.5, y: 0.5 }), { x: 540, y: 960 });
    assert.deepEqual(framePoint('fit', 1920, 1080, { x: 0, y: 0 }), { x: 0, y: 656 });
    assert.deepEqual(framePoint('crop', 1920, 1080, { x: 0.5, y: 0 }), { x: 540, y: 0 });
    assert.match(zoomWindow({ x: 300, y: 700 }).x, /300\.000-iw\/zoom\/2/);
  });

  it('finds sounds in the library, falls back to built-ins, and gives an ending its style’s sound', async () => {
    const { builtinFor, prepareSounds, prepareReactionSounds } = await import('../../src/pipeline/clipping/sounds.ts');
    assert.equal(builtinFor('VINE BOOM!')?.id, 'boom');
    assert.equal(builtinFor('boomer'), null);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sounds-'));
    try {
      const lib = path.join(root, 'lib');
      await fs.mkdir(lib);
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=0.6', path.join(lib, 'bruh-sound.mp3')]);
      const found = await prepareSounds(root, [{ query: 'bruh' }, { query: 'vine boom' }, { query: 'nothing here' }], lib);
      assert.deepEqual(found.items.map((i) => i.sound?.source ?? null), ['library', 'builtin', null]);
      assert.match(found.warnings[0], /No sound found for "nothing here"/);
      const plan = { ...planFromDraft(draft(), project(), analysis()), ending: { style: 'tbc' as const, text: 'TO BE CONTINUED', query: 'to be continued', durationSec: 2.6 } };
      const ready = await prepareReactionSounds(root, plan, lib);
      assert.equal(ready.plan.ending?.sound?.title, 'riser', 'no song in the library: the riser stands in');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('renders a ramp, a circled freeze, an emoji, a meme sound and a fail stamp; and a loop', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reaction-all-'));
    try {
      const dir = path.join(root, 'clip');
      await fs.mkdir(dir, { recursive: true });
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=8', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'source.mp4')]);
      const a = analysis({ durationSec: 8, width: 640, height: 360, peaks: [] });
      const base = planFromDraft(draft({ peakSec: 5, trimStart: 0, trimEnd: 8, header: { text: 'Watch this 💀', highlight: [] } }), project(), a);
      base.captions = false;
      const { prepareReactionSounds } = await import('../../src/pipeline/clipping/sounds.ts');
      const plan: ClipPlan = {
        ...base,
        cutIns: [{ kind: 'freeze', at: 2, durationSec: 1, focus: { x: 0.7, y: 0.4 } }, { kind: 'ramp', at: 5, durationSec: 0.8, replaySec: 0.8 }],
        effects: [...(base.effects ?? []), { at: 6, kind: 'emoji', emoji: '😭' }, { at: 6.5, kind: 'sound', query: 'vine boom' }],
        zoomFocus: { x: 0.7, y: 0.4 },
        ending: { style: 'stamp', text: 'SKILL ISSUE', query: 'vine boom', durationSec: 2 },
      };
      const ready = (await prepareReactionSounds(dir, plan, path.join(root, 'no-library'))).plan;
      const out = await renderReactionShort(dir, 'source.mp4', ready, a);
      assert.ok(Math.abs(out.durationSec - (8 + 1 + 0.8 + 2)) < 0.05, `Short is ${out.durationSec}s`);
      const probe = async () => Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(dir, out.video)])).stdout);
      assert.ok(Math.abs((await probe()) - out.durationSec) < 0.15);

      const looped = await renderReactionShort(dir, 'source.mp4', { ...ready, ending: undefined, loop: true }, a);
      assert.ok(Math.abs(looped.durationSec - 9.8) < 0.05, `loop is ${looped.durationSec}s`);
      assert.ok(Math.abs((await probe()) - 9.8) < 0.15);
      await assert.rejects(fs.access(path.join(dir, 'render-pictures')), 'pictures are cleaned up');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('Emoji pictures by name', () => {
  it('keeps typed emoji and picture names, and finds the picture', async () => {
    const { fitEffects: fe } = await import('../../src/pipeline/clipping/reaction.ts');
    const { findEmojiImage, isEmojiChar } = await import('../../src/pipeline/clipping/emojis.ts');
    assert.deepEqual(fe([{ at: 5, kind: 'emoji', emoji: ' skull  exploding ' }, { at: 7, kind: 'emoji', emoji: '<b>' }], 0, 10, null), [{ at: 5, kind: 'emoji', emoji: 'skull exploding' }]);
    assert.equal(isEmojiChar('💀😭'), true);
    assert.equal(isEmojiChar('skull'), false);
    assert.equal(isEmojiChar('7'), false);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emojis-'));
    try {
      for (const n of ['skull-crossbones-dead.png', 'skull-dead.png', 'loudly-crying-sob.png', 'blue-guy-crying-sob.png']) await fs.writeFile(path.join(dir, n), 'x');
      assert.equal(path.basename((await findEmojiImage('skull', dir))!), 'skull-dead.png', 'the closest name wins');
      assert.equal(path.basename((await findEmojiImage('crying', dir))!), 'loudly-crying-sob.png');
      assert.equal(await findEmojiImage('fire', dir), null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('KLIPY', () => {
  it('reads clip and GIF results, best MP4 first, and searches clips before GIFs', async () => {
    const { searchKlipy, klipyMp4, memeOptions } = await import('../../src/pipeline/clipping/memes.ts');
    const item = { title: 'Its Working', slug: 'its-working-1', file: { hd: { gif: { url: 'https://static.klipy.com/a.gif' }, mp4: { url: 'https://static.klipy.com/hd.mp4' } }, sm: { mp4: { url: 'https://static.klipy.com/sm.mp4' } } } };
    assert.equal(klipyMp4(item), 'https://static.klipy.com/hd.mp4');
    assert.equal(klipyMp4({ file: { md: { mp4: { url: 'https://static.klipy.com/md.mp4?x=1' } } } }), 'https://static.klipy.com/md.mp4?x=1');
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url.replace(/\/v1\/[^/]+\//, '/v1/KEY/').split('?')[0]);
      return new Response(JSON.stringify({ result: true, data: { data: [item, { type: 'ad' }, { title: 'no file' }] } }));
    }) as unknown as typeof fetch;
    assert.deepEqual(await searchKlipy('its working', 'k', 'clips', fake), [{ source: 'klipy', title: 'Its Working', location: 'https://static.klipy.com/hd.mp4', origin: 'https://klipy.com/clips/its-working-1' }]);
    asked.length = 0;
    const { options } = await memeOptions('its working', { KLIPY_API_KEY: 'k', MEME_LIBRARY_DIR: path.join(os.tmpdir(), 'no-such-memes') }, fake);
    assert.equal(options.length, 2);
    assert.deepEqual(asked, ['https://api.klipy.com/api/v1/KEY/clips/search', 'https://api.klipy.com/api/v1/KEY/gifs/search']);
  });
});

describe('Skulls, whips, comic dots, glow and recaps', () => {
  it('places a skull hit after the payoff and fills in skull and recap endings', async () => {
    const r = await import('../../src/pipeline/clipping/reaction.ts');
    const c = r.fitCutIns({ skullAt: 11.8, skullEmoji: 'skull exploding' }, 4, 24, 12);
    assert.deepEqual(c, [{ kind: 'skull', at: 12.4, durationSec: 0.9, emoji: 'skull exploding' }]);
    assert.deepEqual(r.fitEnding({ style: 'skull', text: 'ignored' }), { style: 'skull', text: '', emoji: '💀', query: 'kai cenat boom', durationSec: 1.6 });
    assert.equal(r.fitEnding({ style: 'recap' })?.query, 'dark impact');
  });

  it('recaps the edit’s own highlights, clear of the landing just after the big moment', async () => {
    const r = await import('../../src/pipeline/clipping/reaction.ts');
    const cutIns = [
      { kind: 'freeze' as const, outAt: 4, durationSec: 2, focus: { x: 0.5, y: 0.5 } },
      { kind: 'meme' as const, outAt: 10, durationSec: 1.4 },
      { kind: 'skull' as const, outAt: 16, durationSec: 0.9 },
    ];
    const { shots, landing } = r.recapShots({ cutIns, emojiAt: [7, 7.5], peakOut: 15, mainSec: 20 });
    // The skull hit sits on the landing, so it is left to the landing; the second emoji is too close to the first
    assert.deepEqual(shots, [4.35, 7, 10.2]);
    assert.equal(landing, 15.22, 'just after the flash');
    assert.equal(r.recapShots({ cutIns: [], emojiAt: [], peakOut: 15, mainSec: 20, avoid: [15.22] }).landing, 15.5, 'a landing on a whip blur moves to a clean frame');
    assert.equal(r.recapLength(shots, landing), 3.7);
    assert.deepEqual(r.recapTimes(20, shots, landing), { transitions: [19.75, 20.5, 21.25, 22], landingStart: 22 });
    const graph = r.recapGraph({ mainSec: 20, shots, landing, focus: null, fps: 30 });
    assert.match(graph, /xfade=transition=fadewhite:duration=0\.250:offset=19\.750/, 'a white crossfade into the recap');
    assert.match(graph, /setpts=\(PTS-STARTPTS\)\/0\.8/, 'shots play a little slow');
    assert.match(graph, /atempo=0\.8,volume=0\[/, 'the shots are silent under the music bed');
    assert.match(graph, /hue=s=0,eq=contrast=1\.12.*noise=alls=7/, 'the shots are black and white with grain');
    // The landing (the last piece) comes back in colour
    const landingChain = graph.split(';').find((c) => c.includes('tpad=stop_mode=clone'))!;
    assert.doesNotMatch(landingChain, /hue=s=0/);
    assert.equal(r.fitEnding({ style: 'recap', emoji: 'blue guy' })?.emoji, 'blue guy');
    assert.equal(r.fitEnding({ style: 'recap' })?.emoji, undefined, 'the renderer picks the exploding skull');
    assert.match(r.mixGraph({ durationSec: 10, duck: [], voices: [], sfx: [{ input: 1, atSec: 2, volume: 0.5, lengthSec: 3 }] }), /atrim=0:3\.000,afade=t=in:st=0:d=0\.15,afade=t=out:st=2\.700:d=0\.3/);
    assert.match(graph, /tpad=stop_mode=clone:stop_duration=1\.700/, 'the landing holds');
    assert.match(graph, /\[rv\]/);
    assert.match(graph, /\[ra\]/);
    assert.deepEqual(r.recapShots({ cutIns: [], emojiAt: [], peakOut: null, mainSec: 20 }), { shots: [], landing: null });
    assert.equal(r.recapLength([], null), 0);
  });

  it('builds whip, skull, comic and grade filters', async () => {
    const r = await import('../../src/pipeline/clipping/reaction.ts');
    assert.equal(r.whipFilter([]), null);
    assert.equal(r.whipFilter([2, 5]), "dblur=angle=0:radius=55:enable='between(t,1.930,2.090)+between(t,4.930,5.090)'");
    assert.match(r.skullLookFilter([{ from: 3, to: 3.9 }])!, /hue=s=0:enable='between\(t,3\.000,3\.900\)'.*vignette/);
    assert.match(r.comicFilter([{ from: 1, to: 1.5 }])!, /eq=contrast=1\.9/);
    assert.match(r.endingFilter('skull', 10, 11.6)!, /vignette/);
    assert.match(r.GRADE_FILTER, /saturation=1\.3/);
  });

  it('makes the spoken word glow, a new colour each line', async () => {
    const { generateAssCaptions } = await import('../../src/pipeline/assembly/captions.ts');
    const words = [{ word: 'one.', start: 0, end: 0.3 }, { word: 'two.', start: 2, end: 2.3 }];
    const ass = generateAssCaptions({ beats: [{ index: 0, text: '' }], units: [{ unit_index: 0, duration_ms: 4000 }], beatStartMs: [0], words: { 0: words }, preset: 'social_pop', resolution: { width: 1080, height: 1920 }, glow: true }).assContent;
    const glows = [...ass.matchAll(/\\c(&H[0-9A-F]+&)\\3c\1\\3a&H50&\\bord9\\blur8/g)].map((m) => m[1]);
    assert.deepEqual(glows, ['&HFFF200&', '&H5CFF39&']);
  });

  it('renders a skull hit, a comic flash, punchy colour and a recap ending', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reaction-skull-'));
    try {
      const dir = path.join(root, 'clip');
      await fs.mkdir(dir, { recursive: true });
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=8', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'source.mp4')]);
      const a = analysis({ durationSec: 8, width: 640, height: 360, peaks: [{ at: 3, score: 5 }] });
      const base = planFromDraft(draft({ peakSec: 5, trimStart: 0, trimEnd: 8, header: { text: 'Trap 💀', highlight: [] } }), project(), a);
      const { prepareReactionSounds } = await import('../../src/pipeline/clipping/sounds.ts');
      const plan: ClipPlan = {
        ...base,
        captions: false,
        cutIns: [{ kind: 'skull', at: 5.3, durationSec: 0.9 }],
        effects: [...(base.effects ?? []), { at: 2, kind: 'comic' }],
        ending: { style: 'recap', text: '', query: 'dark impact', durationSec: 2.4 },
      };
      assert.equal(plan.grade, true, 'new reaction plans get punchy colour');
      const ready = (await prepareReactionSounds(dir, plan, path.join(root, 'no-library'))).plan;
      const out = await renderReactionShort(dir, 'source.mp4', ready, a);
      // The clip and the skull hold, then the recap: the skull hit sits on the landing, so only the landing plays
      const expected = 8 + 0.9 + 1.7 - 0.25;
      assert.ok(Math.abs(out.durationSec - expected) < 0.05, `Short is ${out.durationSec}s, expected ${expected}`);
      const real = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(dir, out.video)])).stdout);
      assert.ok(Math.abs(real - expected) < 0.15, `file runs ${real}s`);
      await assert.rejects(fs.access(path.join(dir, 'export', 'short.recap.mp4')), 'the in-between file is cleaned up');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('Ranking web memes', () => {
  it('puts titles with the searched words first and song lyrics last', async () => {
    const { rankOnline } = await import('../../src/pipeline/clipping/memes.ts');
    const o = (title: string) => ({ source: 'klipy' as const, title, location: title, origin: '' });
    const ranked = rankOnline([o('Mine.'), o('Not mine.'), o('♪ You are mine ♪'), o("It's mine now"), o('Peace')], 'its mine now');
    // "Not mine." says the opposite, so it drops below even an unrelated title
    assert.deepEqual(ranked.map((x) => x.title), ["It's mine now", 'Mine.', 'Peace', 'Not mine.', '♪ You are mine ♪']);
  });
});
