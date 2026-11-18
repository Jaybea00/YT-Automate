import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeClipUrl, sourceFromInfo, usableCookieArgs } from '../../src/pipeline/clipping/ingest.ts';
import { cleanTranscript, findPeaks, frameTimes, parseLoudness } from '../../src/pipeline/clipping/analyze.ts';
import { chooseTrim, clipLlm, fitOverlays, fitVoiceLines, planFromDraft, speechGaps, voiceGaps } from '../../src/pipeline/clipping/script.ts';
import { audioFilter, captionTrack, gameVolumeExpression, maskSwear, stripEmoji, videoFilter, zoomExpression } from '../../src/pipeline/clipping/render.ts';
import { composeUploadDescription, hashtag, uploadInfoText } from '../../src/pipeline/clipping/package.ts';
import { clipFile, listClips, loadClip, newClipId, saveClip, updateClip } from '../../src/pipeline/clipping/store.ts';
import type { ClipAnalysis, ClipProject } from '../../src/pipeline/clipping/types.ts';

const analysis = (over: Partial<ClipAnalysis> = {}): ClipAnalysis => ({
  durationSec: 30,
  width: 1920,
  height: 1080,
  hasAudio: true,
  loudness: [],
  peaks: [{ at: 12, score: 9 }],
  words: [],
  transcript: '',
  musicSections: [],
  frames: [],
  ...over,
});

const project = (over: Partial<ClipProject> = {}): ClipProject => ({
  id: '20261118-abcdef12',
  sourceUrl: 'https://x.com/a/status/1',
  creator: '',
  note: '',
  createdAt: '2026-11-18T00:00:00Z',
  updatedAt: '2026-11-18T00:00:00Z',
  status: 'ready',
  step: 'Ready',
  warnings: [],
  ...over,
});

describe('clip links', () => {
  it('cleans X share links and keeps the video number', () => {
    assert.deepEqual(normalizeClipUrl('https://x.com/SpawnYaardReply/status/2123042722437071101/video/1?a=5toH&s=19'), {
      url: 'https://x.com/SpawnYaardReply/status/2123042722437071101',
      item: 1,
      platform: 'X',
    });
    assert.equal(normalizeClipUrl('https://mobile.twitter.com/a/status/5').url, 'https://x.com/a/status/5');
  });

  it('turns YouTube Shorts and short links into watch links', () => {
    assert.equal(normalizeClipUrl('https://youtube.com/shorts/abc123?feature=share').url, 'https://www.youtube.com/watch?v=abc123');
    assert.equal(normalizeClipUrl('https://youtu.be/xyz').url, 'https://www.youtube.com/watch?v=xyz');
  });

  it('rejects things that are not links or posts', () => {
    assert.throws(() => normalizeClipUrl('not a link'));
    assert.throws(() => normalizeClipUrl('https://x.com/someone'));
  });

  it('credits the poster by handle, not by a numeric id', () => {
    assert.equal(sourceFromInfo({ uploader: 'Me', uploader_id: 'meclips' }, 'X', 'u', 'source.mp4').uploaderHandle, '@meclips');
    assert.equal(sourceFromInfo({ uploader: 'Me', uploader_id: '12345' }, 'X', 'u', 'source.mp4').uploaderHandle, '');
  });

  it('skips a cookies file that does not exist', async () => {
    assert.deepEqual(await usableCookieArgs({ YTDLP_COOKIES: 'Z:/nope/cookies.txt' }), []);
    assert.deepEqual(await usableCookieArgs({ YTDLP_COOKIES_FROM_BROWSER: 'firefox' }), ['--cookies-from-browser', 'firefox']);
  });
});

describe('clip analysis', () => {
  it('reads ffmpeg loudness output, silence as -90', () => {
    assert.deepEqual(parseLoudness('frame:0\nlavfi.astats.Overall.RMS_level=-20.5\nframe:1\nlavfi.astats.Overall.RMS_level=-inf\n'), [-20.5, -90]);
  });

  it('finds loud moments, strongest first and spaced apart', () => {
    const loud = Array(60).fill(-30);
    loud[20] = -12; // 10s: big
    loud[21] = -14; // same bump
    loud[44] = -20; // 22s: smaller
    const peaks = findPeaks(loud);
    assert.deepEqual(peaks.map((p) => p.at), [10, 22]);
  });

  it('still finds moments in flat, compressed sound', () => {
    const loud = Array(40).fill(-26);
    loud[30] = -22.5;
    assert.deepEqual(findPeaks(loud).map((p) => p.at), [15]);
  });

  it('drops invented phrases and repeated loops, and marks music', () => {
    const { words, musicSections } = cleanTranscript(
      [
        { text: ' Get', timestamp: [0, 0.3] },
        { text: ' down!', timestamp: [0.3, 5] },
        { text: ' ♪', timestamp: [6, 9] },
        { text: ' Thank', timestamp: [12, 12.2] },
        { text: ' you.', timestamp: [12.2, 12.5] },
        ...Array.from({ length: 6 }, (_, i) => ({ text: ' go', timestamp: [20 + i * 0.3, 20.2 + i * 0.3] as [number, number] })),
      ],
      30,
    );
    assert.deepEqual(words.map((w) => w.word), ['Get', 'down!']);
    assert.equal(words[1].end, 1.5); // stretched word cut back
    assert.deepEqual(musicSections, [{ start: 6, end: 9 }]);
  });

  it('takes stills across the clip and at loud moments, never too close together', () => {
    const times = frameTimes(20, [{ at: 7.1 }], 4);
    assert.ok(times.includes(7.1));
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 0.8);
  });
});

describe('script rules', () => {
  const words = [
    { word: 'hey', start: 2, end: 2.5 },
    { word: 'stop', start: 2.6, end: 3 },
    { word: 'now', start: 10, end: 10.4 },
  ];

  it('finds quiet gaps between dialogue', () => {
    assert.deepEqual(speechGaps(words, 0, 15), [
      { start: 0, end: 1.85 },
      { start: 3.15, end: 9.85 },
      { start: 10.55, end: 15 },
    ]);
  });

  it('keeps voice off the big moment', () => {
    const gaps = voiceGaps([], 0, 20, 10);
    assert.deepEqual(gaps, [{ start: 0, end: 9.7 }, { start: 11.5, end: 20 }]);
  });

  it('keeps lines that fit a gap and drops ones that do not', () => {
    const gaps = [{ start: 0, end: 2 }, { start: 5, end: 12 }];
    const lines = fitVoiceLines(
      [
        { at: 0, text: 'Watch this', slot: 'hook' },
        { at: 1, text: 'this line is far too long to fit into what is left of the gap', slot: 'other' },
        { at: 4.5, text: 'Here it comes', slot: 'build' },
        { at: 30, text: 'Nowhere to go', slot: 'after' },
      ],
      gaps,
    );
    assert.deepEqual(lines.map((l) => [l.at, l.text]), [[0.1, 'Watch this'], [5.1, 'Here it comes']]);
  });

  it('trims long clips to under a minute around the big moment', () => {
    assert.deepEqual(chooseTrim(40, {}, 10), { trimStart: 0, trimEnd: 40 });
    const t = chooseTrim(300, { start: 0, end: 59 }, 200);
    assert.ok(t.trimStart <= 200 && t.trimEnd > 200 && t.trimEnd - t.trimStart <= 59);
  });

  it('keeps on-screen texts clear of the hook and brief', () => {
    const o = fitOverlays([{ at: 0.5, until: 9, text: 'wait for it' }], 0, 30, 2.5);
    assert.deepEqual(o, [{ at: 2.7, until: 5.7, text: 'wait for it' }]);
  });

  it('builds a usable plan even without a script', () => {
    const plan = planFromDraft(null, project({ note: 'escape on a bike' }), analysis());
    assert.equal(plan.hook, 'escape on a bike');
    assert.equal(plan.peakSec, 12);
    assert.equal(plan.layout, 'fit');
    assert.equal(plan.voiceLines.length, 0);
    assert.equal(plan.cleanCaptions, true);
    assert.equal(planFromDraft(null, project(), analysis({ width: 1080, height: 1920 })).layout, 'original');
  });

  it('picks Gemini by default and Claude when asked', () => {
    assert.equal(clipLlm({ GEMINI_API_KEY: 'g' }).name, 'Gemini');
    assert.equal(clipLlm({ CLIP_LLM_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'a' }).ctx.model, 'claude-opus-5-5');
    assert.throws(() => clipLlm({ CLIP_LLM_PROVIDER: 'claude' }), /ANTHROPIC_API_KEY/);
  });
});

describe('render graph', () => {
  it('zooms in just before the big moment and eases out', () => {
    assert.match(zoomExpression(10), /^1\+0\.14\*min\(clip\(\(in\/30-9\.880\)/);
  });

  it('builds crop and fit layouts with captions burned in', () => {
    assert.match(videoFilter({ layout: 'crop', durationSec: 20, peakSec: 5, zoom: true, assFile: 'short.ass' }), /crop=1080:1920.*zoompan.*ass=short\.ass/);
    const fit = videoFilter({ layout: 'fit', durationSec: 20, peakSec: null, zoom: true, assFile: 'short.ass' });
    assert.match(fit, /gblur/);
    assert.doesNotMatch(fit, /zoompan/);
  });

  it('ducks game sound under voice lines and mutes music', () => {
    assert.equal(gameVolumeExpression([{ start: 1, end: 2 }], [{ start: 5, end: 6 }]), 'if(between(t,5.000,6.000),0,1)*if(between(t,1.000,2.000),0.28,1)');
    const graph = audioFilter({ hasAudio: true, durationSec: 10, duck: [], mute: [], voices: [{ input: 1, atSec: 1.5 }], sfx: { input: 2, atSec: 4 } });
    assert.match(graph, /adelay=1500\|1500/);
    assert.match(graph, /amix=inputs=3/);
    assert.match(audioFilter({ hasAudio: false, durationSec: 10, duck: [], mute: [], voices: [], sfx: null }), /anullsrc/);
  });

  it('masks swear words and drops emoji from on-screen text', () => {
    assert.equal(maskSwear('fuck!'), 'f***!');
    assert.equal(maskSwear('Shit,'), 'S***,');
    assert.equal(maskSwear('hello'), 'hello');
    assert.equal(stripEmoji('Wait for it 💀🔥'), 'Wait for it');
  });

  it('times captions and banners from the start of the Short', () => {
    const plan = planFromDraft(null, project({ note: 'Hook 😳' }), analysis({ words: [{ word: 'fuck', start: 6, end: 6.4 }] }));
    plan.trimStart = 5;
    plan.trimEnd = 25;
    plan.overlays = [{ at: 9, until: 11, text: 'wait for it' }];
    plan.voiceLines = [{ at: 15, text: 'here we go', slot: 'build', audioFile: 'voice/a.wav', words: [{ word: 'here', start: 0, end: 0.3 }] }];
    const { words, banners } = captionTrack(plan, analysis({ words: [{ word: 'fuck', start: 6, end: 6.4 }] }));
    assert.deepEqual(words.map((w) => [w.word, w.start]), [['f***', 1], ['here', 10]]);
    assert.deepEqual(banners.map((b) => [b.text, b.startMs]), [['Hook', 0], ['wait for it', 4000]]);
  });
});

describe('upload details', () => {
  it('turns tags into hashtags', () => {
    assert.equal(hashtag('gta 6 funny moments'), '#GTA6FunnyMoments');
  });

  it('credits the creator with a link, then hashtags', () => {
    const p = project({ creator: '@clipper', source: { title: '', postText: '', uploader: 'X', uploaderHandle: '@poster', platform: 'X', pageUrl: 'https://x.com/a/status/1', file: 'source.mp4' } });
    p.plan = planFromDraft(null, p, analysis());
    p.plan.description = 'He did not see it coming.';
    p.plan.tags = ['gta 6'];
    assert.equal(composeUploadDescription(p), 'He did not see it coming.\n\n🎥 Clip by @clipper (https://x.com/a/status/1)\n\n#Shorts #GTA6');
    assert.match(uploadInfoText(p), /TITLE OPTIONS\n1\. /);
  });
});

describe('clip store', () => {
  let dir = '';
  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clips-'));
    process.env.CLIPPING_DIR = dir;
  });
  after(async () => {
    delete process.env.CLIPPING_DIR;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('saves, updates and lists clips', async () => {
    const id = newClipId();
    await saveClip(project({ id }));
    await updateClip(id, (p) => {
      p.status = 'failed';
    });
    assert.equal((await loadClip(id))?.status, 'failed');
    assert.deepEqual((await listClips()).map((c) => c.id), [id]);
  });

  it('refuses file names outside the clip folder', () => {
    assert.throws(() => clipFile('20261118-abcdef12', '../../secret.txt'));
    assert.throws(() => clipFile('../evil', 'x'));
  });
});
