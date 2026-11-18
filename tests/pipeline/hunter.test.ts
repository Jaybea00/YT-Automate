import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeStreamUrl, parseJson3Captions, parseUploadedChat, parseYoutubeChat } from '../../src/pipeline/hunter/source.ts';
import { findCandidates, rises, zScores } from '../../src/pipeline/hunter/candidates.ts';
import { guessRecipe, reactionHits } from '../../src/pipeline/hunter/recipes.ts';
import { buildJudgePrompt, clampMoment, linesFromWords } from '../../src/pipeline/hunter/judge.ts';
import { timestampUrl } from '../../src/pipeline/hunter/run.ts';
import { huntFile, loadHunt, newHuntId, saveHunt, updateHunt } from '../../src/pipeline/hunter/store.ts';
import type { Candidate, Hunt } from '../../src/pipeline/hunter/types.ts';

describe('stream links', () => {
  it('accepts YouTube streams, including /live/ links', () => {
    assert.deepEqual(normalizeStreamUrl('https://www.youtube.com/watch?v=abc&t=55s'), { url: 'https://www.youtube.com/watch?v=abc', platform: 'YouTube' });
    assert.equal(normalizeStreamUrl('https://youtube.com/live/xyz?si=1').url, 'https://www.youtube.com/watch?v=xyz');
  });

  it('accepts Twitch past broadcasts but not channels', () => {
    assert.deepEqual(normalizeStreamUrl('https://www.twitch.tv/videos/2283401234?t=1h2m'), { url: 'https://www.twitch.tv/videos/2283401234', platform: 'Twitch' });
    assert.throws(() => normalizeStreamUrl('https://www.twitch.tv/somestreamer'), /past-broadcast/);
  });
});

describe('chat and captions', () => {
  it('reads YouTube chat replay lines, skipping system messages', () => {
    const line = (ms: number, item: unknown) => JSON.stringify({ replayChatItemAction: { videoOffsetTimeMsec: String(ms), actions: [{ addChatItemAction: { item } }] } });
    const chat = parseYoutubeChat(
      [
        line(0, { liveChatViewerEngagementMessageRenderer: { message: { runs: [{ text: 'Live chat replay is on' }] } } }),
        line(65000, { liveChatTextMessageRenderer: { message: { runs: [{ text: 'clip it ' }, { emoji: { emojiId: '😂', shortcuts: [':joy:'] } }] } } }),
        line(5000, { liveChatTextMessageRenderer: { message: { runs: [{ text: 'hi' }] } } }),
        'not json',
      ].join('\n'),
    );
    assert.deepEqual(chat, [{ t: 5, text: 'hi' }, { t: 65, text: 'clip it 😂' }]);
  });

  it('reads TwitchDownloader chat files and refuses others', () => {
    const chat = parseUploadedChat(JSON.stringify({ comments: [{ content_offset_seconds: 12.5, message: { body: 'KEKW' } }] }));
    assert.deepEqual(chat, [{ t: 12.5, text: 'KEKW' }]);
    assert.throws(() => parseUploadedChat('{"hello":1}'));
  });

  it('reads json3 captions', () => {
    const lines = parseJson3Captions(JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'oh ' }, { utf8: 'my god' }] }, { tStartMs: 2000, segs: [{ utf8: '\n' }] }] }));
    assert.deepEqual(lines, [{ t: 1, text: 'oh my god' }]);
  });
});

describe('recipes', () => {
  it('guesses the kind of moment from chat and speech', () => {
    assert.equal(guessRecipe(['KEKW', 'LMAO', '💀'], []), 'funny');
    assert.equal(guessRecipe(['the cops lol'], ['go go go we need to lose the police']), 'chase');
    assert.equal(guessRecipe(['hello'], ['nice weather']), 'other');
  });

  it('counts reactions, including "clip it"', () => {
    assert.equal(reactionHits(['clip that', 'POG', 'what is this game called']), 2);
  });
});

describe('finding moments', () => {
  it('scores rises against what came before', () => {
    assert.deepEqual(rises([1, 1, 5], 2), [0, 0, 4]);
    assert.deepEqual(zScores([2, 2, 2]), [0, 0, 0]);
  });

  it('flags a loud moment that chat reacts to, and keeps flags spread out', () => {
    const durationSec = 600;
    const loudness = Array(durationSec * 2).fill(-30);
    loudness.fill(-10, 400, 404); // 200s: loud
    loudness.fill(-14, 420, 424); // 210s: loud again, too close to flag twice
    loudness.fill(-18, 900, 904); // 450s: smaller
    const chat = Array.from({ length: 25 }, (_, i) => ({ t: 206 + i * 0.3, text: i % 2 ? 'KEKW' : 'clip it' }));
    const found = findCandidates({ durationSec, loudness, chat, captions: [] });
    assert.ok(found.length >= 2);
    assert.equal(found[0].at, 200);
    assert.equal(found[0].recipeGuess, 'funny');
    assert.equal(found[0].start, 175);
    assert.equal(found[0].end, 212);
    for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) assert.ok(Math.abs(found[i].at - found[j].at) >= 45);
  });

  it('works from sound alone and skips the stream opening', () => {
    const loudness = Array(400).fill(-30);
    loudness.fill(-5, 10, 14); // 5s: the opening
    loudness.fill(-12, 300, 304); // 150s
    const found = findCandidates({ durationSec: 200, loudness, chat: [], captions: [] });
    assert.equal(found[0].at, 150);
    assert.ok(found.every((c) => c.at >= 30));
  });
});

describe('judging', () => {
  const c: Candidate = { at: 100, start: 75, end: 112, score: 3, recipeGuess: 'funny', chatCount: 4 };

  it('keeps judged moments inside their stretch and 10-60 seconds long', () => {
    assert.deepEqual(clampMoment(80, 110, c, 1000), { start: 80, end: 110 });
    assert.deepEqual(clampMoment(10, 500, c, 1000), { start: 70, end: 120 });
    // too short: the end reaches 2s past the peak, then both sides are padded to 10s
    assert.deepEqual(clampMoment(99, 101, c, 1000), { start: 95.5, end: 105.5 });
  });

  it('groups words into lines at pauses', () => {
    assert.deepEqual(linesFromWords([{ word: 'no', start: 1, end: 1.2 }, { word: 'way', start: 1.3, end: 1.5 }, { word: 'bro', start: 4, end: 4.2 }]), [{ t: 1, text: 'no way' }, { t: 4, text: 'bro' }]);
  });

  it('gives the judge each stretch with its speech and chat', () => {
    const prompt = buildJudgePrompt({ title: 'GTA 6 day 1', uploader: 'Streamer' }, [{ index: 3, candidate: c, speech: [{ t: 99, text: 'oh no' }], chat: [{ t: 104, text: 'LUL' }] }]);
    assert.match(prompt, /STRETCH 3: 75\.0-112\.0s \(1:15-1:52\)/);
    assert.match(prompt, /\[99\.0\] oh no/);
    assert.match(prompt, /\[104\] LUL/);
  });
});

describe('links and storage', () => {
  it('links to the moment in the stream', () => {
    assert.equal(timestampUrl('https://www.youtube.com/watch?v=abc', 'YouTube', 3725.4), 'https://www.youtube.com/watch?v=abc&t=3725');
    assert.equal(timestampUrl('https://www.twitch.tv/videos/1', 'Twitch', 3725), 'https://www.twitch.tv/videos/1?t=1h2m5s');
  });

  let dir = '';
  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hunts-'));
    process.env.HUNTS_DIR = dir;
  });
  after(async () => {
    delete process.env.HUNTS_DIR;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('applies overlapping updates one after another without losing any', async () => {
    const id = newHuntId();
    const hunt: Hunt = {
      id, url: 'u', platform: 'YouTube', title: '', uploader: '', uploaderHandle: '', pageUrl: 'u', durationSec: 0, creator: '', maxMoments: 12,
      createdAt: '', updatedAt: '', status: 'queued', step: '', warnings: [], signals: { chat: 0, captions: false, audio: false, uploadedChat: false }, candidates: [], moments: [],
    };
    await saveHunt(hunt);
    await Promise.all(Array.from({ length: 5 }, (_, i) => updateHunt(id, (h) => void h.warnings.push(`w${i}`))));
    assert.equal((await loadHunt(id))?.warnings.length, 5);
    assert.throws(() => huntFile(id, '../../x'));
  });
});
