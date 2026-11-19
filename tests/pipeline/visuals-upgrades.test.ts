import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capitalisedNames, graphicForWeakShot, statFromNarration } from '../../src/pipeline/visuals/weak-match.ts';
import { freshnessAdjusted, usedElsewhere, withVideoSources } from '../../src/pipeline/visuals/footage-usage.ts';
import { preferFresh } from '../../src/pipeline/visuals/footage-picker.ts';
import { isGameTopic, searchMoments, type MomentFootage } from '../../src/pipeline/visuals/moments-footage.ts';
import { lookText, shortlist, similarityToScore } from '../../src/pipeline/visuals/local-look.ts';
import { dHash, hammingHex, meanSaturation, reviewStoryboard, type ShotLook } from '../../src/pipeline/visuals/storyboard-review.ts';
import type { StoryboardShot } from '../../src/pipeline/visuals/storyboard.ts';
import type { MediaCandidate } from '../../src/pipeline/visuals/types.ts';
import type { ShotPlan } from '../../src/lib/script/generate-script.ts';

const cand = (id: string, pageUrl = `https://x/${id}`): MediaCandidate => ({ id, provider: 'pixabay', mediaType: 'video', thumbnailUrl: '', downloadUrl: `https://dl/${id}`, pageUrl });

describe('weak matches become graphics', () => {
  it('turns the first real quantity into a stat card, skipping years', () => {
    assert.deepEqual(statFromNarration('In 1929, more than 4,000 banks failed across America.'), { value: 4000, label: 'banks failed across America' });
    assert.deepEqual(statFromNarration('It cost $14 billion to build.'), { value: 14, prefix: '$', suffix: 'B', label: 'to build' });
    assert.deepEqual(statFromNarration('Unemployment hit 25 percent of workers'), { value: 25, suffix: '%', label: 'workers' });
    assert.equal(statFromNarration('It happened in 1914.'), null);
    assert.equal(statFromNarration('He ran 10.'), null);
  });

  it('picks a stat, else a country map, else nothing', () => {
    const shot = (covers: string): ShotPlan => ({ visual_type: 'stock', visual_query: 'q', covers, word_start: 0, word_count: 5 });
    const isCountry = (n: string) => ['Egypt', 'United Kingdom'].includes(n);
    assert.equal(graphicForWeakShot(shot('Over 300 ships waited outside Egypt'), isCountry)?.visual_type, 'stat');
    const map = graphicForWeakShot(shot('The canal runs through Egypt'), isCountry);
    assert.deepEqual([map?.visual_type, map?.map], ['geo_map', { places: ['Egypt'], mode: 'locate' }]);
    assert.equal(graphicForWeakShot(shot('Nobody saw it coming'), isCountry), null);
    assert.deepEqual(capitalisedNames('The United Kingdom and Egypt signed it'), ['The United Kingdom', 'Egypt']);
  });
});

describe('fresh footage across the channel', () => {
  it('records each video\'s sources, replacing what it recorded before', () => {
    let usage = withVideoSources({ version: 1, sources: {} }, 'v1', ['a', 'b', 'library:1', 'moment:x']);
    usage = withVideoSources(usage, 'v2', ['a']);
    usage = withVideoSources(usage, 'v1', ['a']); // v1 re-rendered without b
    assert.deepEqual(Object.keys(usage.sources).sort(), ['a']);
    assert.equal(usedElsewhere(usage, 'a', 'v1'), 1);
    assert.equal(usedElsewhere(usage, 'a', 'v3'), 2);
  });

  it('puts unused footage first among equally good fits, but keeps a clearly better reused clip', () => {
    assert.equal(freshnessAdjusted(8, 5), 5);
    const ranked = [
      { candidate: cand('reused'), score: 8 },
      { candidate: cand('fresh'), score: 7.5 },
      { candidate: cand('great-reused'), score: 9.5 },
    ];
    const used = (k: string) => (k.includes('reused') ? 1 : 0);
    assert.deepEqual(preferFresh(ranked, used).map((r) => r.candidate.id), ['great-reused', 'fresh', 'reused']);
    assert.equal(preferFresh(ranked).length, 3);
  });
});

describe('hunted moments as footage', () => {
  it('only for videos about a game', () => {
    assert.ok(isGameTopic('GTA 6 map size explained'));
    assert.ok(isGameTopic('The history of video games'));
    assert.equal(isGameTopic('Why World War I started'), false);
  });

  it('finds moments by what happens in them, credited to the streamer', () => {
    const m: MomentFootage = { key: 'hunt:h:m1', title: 'Plane crash test', description: 'Jumps out of a plane before it crashes', transcript: '', creator: '@lemon', pageUrl: 'https://yt/x', file: 'C:/m1.mp4', thumb: null, durationSec: 20 };
    const found = searchMoments('plane crashing into the sea', [m]);
    assert.equal(found[0].pageUrl, 'moment:hunt:h:m1');
    assert.equal(found[0].downloadUrl, 'C:/m1.mp4');
    assert.match(found[0].attribution ?? '', /@lemon/);
    assert.deepEqual(searchMoments('stock market', [m]), []);
  });
});

describe('local first look', () => {
  it('maps similarity onto the vision check\'s scale', () => {
    assert.equal(similarityToScore(0.25), 6);
    assert.equal(similarityToScore(0.31), 9);
    assert.equal(similarityToScore(0.05), 0);
  });

  it('shows the vision check only the best plausible candidates', () => {
    const scored = [0.3, 0.27, 0.21, 0.15].map((similarity, i) => ({ candidate: cand(String(i)), similarity }));
    assert.deepEqual(shortlist(scored, 6).map((c) => c.id), ['0', '1', '2']);
    assert.deepEqual(shortlist(scored.slice(3), 6).map((c) => c.id), ['3']);
    assert.equal(lookText('container ship', 'it squeezed through'), 'container ship. it squeezed through');
  });
});

describe('storyboard review', () => {
  it('hashes frames and measures colour', () => {
    const ramp = new Uint8Array(72).map((_, i) => 255 - (i % 9) * 20);
    assert.equal(dHash(ramp), 'ffffffffffffffff');
    assert.equal(hammingHex('ffff', 'fff0'), 4);
    assert.equal(meanSaturation(new Uint8Array([100, 100, 100, 200, 200, 200])), 0);
    assert.equal(meanSaturation(new Uint8Array([255, 0, 0])), 1);
  });

  it('flags near-duplicate neighbours, era jumps, long stills, text, gaps and reuse', () => {
    const shot = (order: number, over: Partial<StoryboardShot> = {}): StoryboardShot => ({
      beatIndex: 0, shotIndex: order, order, startSec: order * 3, durationSec: 3, renderedType: 'stock', plannedType: 'stock', covers: 'words', query: 'q',
      clipPath: '', sourceUrl: `https://x/${order}`, attribution: null, still: false, fallback: false, needsCheck: false, note: null, alternatives: 2, ...over,
    });
    const shots = [shot(0), shot(1), shot(2), shot(3, { still: true, durationSec: 9 }), shot(4, { fallback: true, renderedType: 'kinetic_text' }), shot(5, { needsCheck: true })];
    const looks = new Map<number, ShotLook>([
      [0, { hash: 'ffff0000ffff0000', saturation: 0.3 }],
      [1, { hash: 'ffff0000ffff0001', saturation: 0.3 }], // same picture as 0
      [2, { hash: '0000ffff0000ffff', saturation: 0.02, textOrLogo: 0.8 }], // grey after colour, and text
      [3, { hash: '1234567812345678', saturation: 0.3 }],
    ]);
    const issues = reviewStoryboard(shots, looks, (url) => (url.endsWith('/3') ? 2 : 0));
    const got = issues.map((i) => `${i.kind}@${i.order}`);
    assert.deepEqual(got, ['duplicate@1', 'era_jump@2', 'text_or_logo@2', 'era_jump@3', 'long_still@3', 'reused@3', 'gap@4', 'needs_check@5']);
    assert.equal(issues.find((i) => i.kind === 'duplicate')?.severity, 'high');
  });
});
