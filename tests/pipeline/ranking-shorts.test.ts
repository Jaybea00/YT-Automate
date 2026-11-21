import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asRankingShort, closingBeat, RANKING_CLOSING_LINE, rankBadge, rankingMinutes, rankingShortRules, rankMarkers, rankName, rankOfBeat, withClosingLine } from '../../src/lib/script/ranking.ts';
import { ReadyScriptSchema, scriptFromReady } from '../../src/lib/script/ready-script.ts';
import { normalizeShortPlans, shortBanners, WHOLE_SHORT_MAX_SEC } from '../../src/pipeline/publish/shorts.ts';

const script = [
  'Number one was never caught. And he jumped out of a plane to do it.',
  'Number 5: The Antwerp Diamond Heist. A hundred million in diamonds, gone in one weekend.',
  'They beat ten layers of security.',
  'Number four: The Lufthansa Heist. Six million dollars from JFK airport.',
  '#3 The Banco Central Heist — a tunnel under the street.',
  'At number two, the Isabella Stewart Gardner Museum.',
  'Number 1: D.B. Cooper. He took two hundred thousand dollars and vanished.',
].map((text) => ({ text }));

describe('Ranking Shorts', () => {
  it('reads the rank a beat opens with, in words or digits', () => {
    assert.equal(rankOfBeat('Number 5: The Antwerp Diamond Heist.'), 5);
    assert.equal(rankOfBeat('Number four: The Lufthansa Heist.'), 4);
    assert.equal(rankOfBeat('#3 The Banco Central Heist'), 3);
    assert.equal(rankOfBeat('At number two, the museum.'), 2);
    assert.equal(rankOfBeat('No. 1: Cooper.'), 1);
    assert.equal(rankOfBeat('He was number one on the list.'), null, 'only at the start of a beat');
    assert.equal(rankOfBeat('Numbers matter.'), null);
  });

  it('takes a short name after the marker, and none when it is a whole sentence', () => {
    assert.equal(rankName('Number 5: The Antwerp Diamond Heist. A hundred million…'), 'The Antwerp Diamond Heist');
    assert.equal(rankName('#3 The Banco Central Heist — a tunnel.'), 'The Banco Central Heist');
    assert.equal(rankName('Number one was never caught and he jumped out of a plane over Washington.'), '');
  });

  it('finds each item where it starts, skipping the teaser of number one', () => {
    assert.deepEqual(
      rankMarkers(script).map((m) => [m.beat, m.rank, m.name]),
      [
        [1, 5, 'The Antwerp Diamond Heist'],
        [3, 4, 'The Lufthansa Heist'],
        [4, 3, 'The Banco Central Heist'],
        [5, 2, 'the Isabella Stewart Gardner Museum'],
        [6, 1, 'D.B. Cooper'],
      ],
    );
    assert.equal(rankBadge({ rank: 3, name: 'The Banco Central Heist' }), '#3 THE BANCO CENTRAL HEIST');
    assert.equal(rankBadge({ rank: 1, name: '' }), '#1');
  });

  it('is not a ranking with fewer than two items, and ignores ranks out of order', () => {
    assert.deepEqual(rankMarkers([{ text: 'Number one was a fluke.' }, { text: 'It never happened again.' }]), []);
    const shuffled = rankMarkers([{ text: 'Number 3: A.' }, { text: 'Number 5: B.' }, { text: 'Number 2: C.' }]);
    assert.deepEqual(shuffled.map((m) => m.rank), [3, 2]);
  });

  it('shows the hook, then each badge from its start, then the end card', () => {
    const banners = shortBanners('5 HEISTS THAT WORKED', 50, {
      labels: [
        { text: '#2 TWO', startMs: 30000 },
        { text: '#5 FIVE', startMs: 4000 },
        { text: '#1 ONE', startMs: 40000 },
      ],
      endCard: 'WHAT WOULD YOUR #1 BE?',
    });
    assert.deepEqual(
      banners.map((b) => [b.text, b.startMs, b.endMs]),
      [
        ['5 HEISTS THAT WORKED', 0, 4000],
        ['#5 FIVE', 4000, 30000],
        ['#2 TWO', 30000, 40000],
        ['#1 ONE', 40000, 47500],
        ['WHAT WOULD YOUR #1 BE?', 47500, 50000],
      ],
    );
  });

  it('ends on the spoken question, added once, over number one’s picture', () => {
    const beats = [
      { index: 0, text: 'Number one was never caught.', visual_type: 'stock', visual_query: 'a', duration_estimate_seconds: 3 },
      { index: 1, text: 'Number 1: D.B. Cooper.', visual_type: 'archive', visual_query: 'Cooper sketch', duration_estimate_seconds: 4 },
    ];
    const closed = withClosingLine(beats);
    assert.equal(closed.length, 3);
    assert.deepEqual([closed[2].index, closed[2].text, closed[2].visual_type, closed[2].visual_query], [2, RANKING_CLOSING_LINE, 'archive', 'Cooper sketch']);
    assert.equal(withClosingLine(closed).length, 3, 'never twice');
    assert.equal(closingBeat(closed), 2);
    assert.equal(closingBeat(beats), -1);
    assert.equal(closingBeat([{ text: 'x' }, { text: "So what's YOUR #1?" }]), 1);
    assert.equal(asRankingShort({ title_options: ['T'], beats }).beats.length, 3);
    assert.equal(rankOfBeat(RANKING_CLOSING_LINE), null, 'the question is not a rank');
  });

  it('shows the end card while its line is spoken', () => {
    const banners = shortBanners('HOOK', 50, { labels: [{ text: '#1 ONE', startMs: 30000 }], endCard: 'END?', endCardStartMs: 46200 });
    assert.deepEqual(banners.slice(-2).map((b) => [b.text, b.startMs, b.endMs]), [
      ['#1 ONE', 30000, 46200],
      ['END?', 46200, 50000],
    ]);
  });

  it('keeps the plain Short banners when there is no ranking', () => {
    assert.deepEqual(
      shortBanners('HOOK', 30).map((b) => [b.text, b.startMs, b.endMs]),
      [
        ['HOOK', 0, 27500],
        ['FULL STORY ON THE CHANNEL', 27500, 30000],
      ],
    );
  });

  it('marks a script as a ranking Short of its own', () => {
    const s = asRankingShort({ title_options: ['5 Heists That Actually Worked'], beats: [] });
    assert.equal(s.format, 'short');
    assert.equal(s.ranking, true);
    assert.deepEqual(s.short, { parent_video_id: null, hook_banner: '5 Heists That Actually Worked' });
    assert.equal(s.beat_pause_seconds, 0);
    assert.equal(asRankingShort({ title_options: ['T'] }, '5 HEISTS').short.hook_banner, '5 HEISTS');
    assert.match(rankingShortRules(), /Number N: <name>\./);
  });

  it('sizes a Top 5 at about a minute and a Top 10 at about two', () => {
    assert.match(rankingShortRules(5), /Rank 5 items/);
    assert.match(rankingShortRules(5), /under a minute/);
    assert.match(rankingShortRules(10), /Rank 10 items/);
    assert.match(rankingShortRules(10), /about two minutes/);
    assert.ok(rankingMinutes(5) > 0.7 && rankingMinutes(5) < 1, `${rankingMinutes(5)}`);
    assert.ok(rankingMinutes(10) > 1.4 && rankingMinutes(10) < 2.5, `${rankingMinutes(10)}`);
  });

  it('lets a whole Short run to 3 minutes, while cut-downs stay under one', () => {
    const beat = (index: number, startSec: number, sec: number) =>
      ({ index, voiceStartMs: startSec * 1000, voiceMs: sec * 1000, sceneStartMs: startSec * 1000, sceneMs: sec * 1000 }) as never;
    const timeline = { version: 1, beats: Array.from({ length: 10 }, (_, i) => beat(i, i * 12, 12)) } as never; // 120 s
    const plan = [{ startBeat: 0, endBeat: 9, title: 'T', hook: 'H' }];
    assert.equal(normalizeShortPlans(plan, timeline, WHOLE_SHORT_MAX_SEC)[0].endBeat, 9, 'two minutes fits whole');
    assert.equal(normalizeShortPlans(plan, timeline)[0].endBeat, 3, 'a cut-down is trimmed to under a minute');
    assert.equal(WHOLE_SHORT_MAX_SEC, 179);
  });

  it('turns a ready-made script into numbered, timed beats', () => {
    const ready = ReadyScriptSchema.parse({
      title_options: ['5 Heists That Actually Worked'],
      beats: [{ text: 'Number one was never caught.' }, { text: 'Number 5: Antwerp.', visual_type: 'archive', visual_query: 'Antwerp diamond district 2003' }],
    });
    const s = scriptFromReady(ready);
    assert.equal(s.beats.length, 2);
    assert.deepEqual(s.beats.map((b) => [b.index, b.visual_type]), [[0, 'stock'], [1, 'archive']]);
    assert.equal(s.beats[0].visual_query, 'Number one was never caught.');
    assert.equal(s.beats[1].visual_query, 'Antwerp diamond district 2003');
    assert.ok(s.beats.every((b) => b.duration_estimate_seconds >= 2));
    assert.equal(ReadyScriptSchema.safeParse({ title_options: [], beats: [{ text: 'x' }] }).success, false);
  });
});
