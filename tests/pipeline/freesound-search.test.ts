import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bestMatches, broaderQueries, fetchPolitely, isAbout } from '../../src/pipeline/assembly/real-sfx.ts';

describe('Freesound search', () => {
  it('tries a phrase, then shorter forms of it', () => {
    assert.deepEqual(broaderQueries('stadium crowd cheer goal'), ['stadium crowd cheer goal', 'stadium crowd cheer', 'stadium crowd']);
    assert.deepEqual(broaderQueries('whistle'), ['whistle']);
  });

  it('only settles for a sound that is what was asked for', () => {
    assert.equal(isAbout({ name: 'Old typewriter keys', tags: [] }, 'typewriter single key strike'), true);
    assert.equal(isAbout({ name: 'Computer Keyboard - single key', tags: ['keyboard', 'computer'] }, 'typewriter single key strike'), false);
    assert.equal(isAbout({ name: 'SFX_0042.wav', tags: ['rubber', 'stamp', 'office'] }, 'rubber stamp hit paper'), true, 'tags count');
    assert.equal(isAbout({ name: 'anything', tags: [] }, 'soft hit'), true, 'nothing telling to check');
    assert.equal(isAbout({ name: "Farmer's market front", tags: ['crowd', 'people'] }, 'stadium crowd ambience'), false, 'the main subject must be there');
    const ranked = bestMatches(
      [
        { name: 'Ambience 01', tags: ['city', 'traffic'] },
        { name: 'City street at night', tags: [] },
        { name: 'Kitchen', tags: ['street'] },
      ],
      'city street ambience traffic',
    );
    assert.deepEqual(ranked.map((r) => r.name), ['City street at night', 'Ambience 01'], 'named matches first; a kitchen tagged "street" is out');
    assert.equal(isAbout({ name: 'whistle', tags: [] }, 'referee whistle'), true, 'any telling word in the name will do');
  });

  it('waits and retries when Freesound asks it to slow down', async () => {
    const original = globalThis.fetch;
    const waits: number[] = [];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls < 3 ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }) : new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const res = await fetchPolitely('https://freesound.org/x', 3, async (ms) => {
        waits.push(ms);
      });
      assert.equal(res.status, 200);
      assert.deepEqual(waits, [2000, 2000]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
