import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeDescription, DESCRIPTION_MAX_CHARS, generateMetadata, groundedTitles, normalizeMetadata, TAGS_MAX_CHARS } from '../../src/pipeline/publish/metadata.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';

describe('Publishing metadata', () => {
  it('applies YouTube limits: title length, the 500-character tag budget, three hashtags', () => {
    const m = normalizeMetadata({
      titles: [
        { text: '"The Day Wall Street Broke"', angle: 'Story' },
        { text: 'the day wall street broke', angle: 'story' },
        { text: 'x'.repeat(120), angle: 'stakes' },
        { text: 'A Very Long But Still Acceptable Title About The Great Crash Of 1929 And After', angle: 'number' },
      ],
      hook: ' Hook. ',
      summary: 'Summary.',
      tags: ['wall street', 'Wall Street', '#crash', ...Array.from({ length: 60 }, (_, i) => `great depression tag number ${i}`)],
      hashtags: ['#Wall Street', 'GreatDepression', '#history', '#extra'],
    });
    assert.deepEqual(m.titles.map((t) => t.text), ['The Day Wall Street Broke', 'A Very Long But Still Acceptable Title About The Great Crash Of 1929 And After']);
    assert.equal(m.titles[0].angle, 'story');
    assert.deepEqual(m.tags.slice(0, 2), ['wall street', 'crash']);
    const cost = m.tags.reduce((n, t, i) => n + t.length + (t.includes(' ') ? 2 : 0) + (i ? 1 : 0), 0);
    assert.ok(cost <= TAGS_MAX_CHARS, `tags fit YouTube's budget (${cost})`);
    assert.deepEqual(m.hashtags, ['#WallStreet', '#GreatDepression', '#history']);
  });

  it('drops titles stating figures the video does not', () => {
    const titles = [{ text: '16 Million Shares in One Day', angle: 'number' }, { text: '50 Billion Lost', angle: 'stakes' }, { text: 'The Crash', angle: 'story' }];
    assert.deepEqual(groundedTitles(titles, 'More than sixteen million shares changed hands.').map((t) => t.text), ['16 Million Shares in One Day', 'The Crash']);
  });

  it('puts the hook first and keeps chapters and credits within the 5,000-character limit', () => {
    const d = composeDescription({ hook: 'The hook.', summary: 'The summary.', chapters: '00:00 - Start', credits: 'Music: x', hashtags: ['#a', '#b'] });
    assert.equal(d, 'The hook.\n\nThe summary.\n\nChapters:\n00:00 - Start\n\nCredits:\nMusic: x\n\n#a #b');
    const long = composeDescription({ hook: 'h'.repeat(6000), summary: '', chapters: '00:00 - Start', credits: 'Music: x' });
    assert.ok(long.length <= DESCRIPTION_MAX_CHARS);
    assert.ok(long.endsWith('Credits:\nMusic: x'), 'the required parts survive the cut');
  });

  it('asks the LLM with the narration and facts, and returns grounded options', async () => {
    let prompt = '';
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async (req) => {
        prompt = req.prompt;
        return {
          data: { titles: [{ text: 'When 30 Billion Vanished', angle: 'stakes' }, { text: '99 Banks in a Day', angle: 'number' }], hook: 'h', summary: 's', tags: ['t'], hashtags: ['#h'] } as never,
          usage: {},
        };
      },
    };
    const m = await generateMetadata({ topic: '1929', narration: ['About thirty billion dollars vanished.'], facts: ['The Dow fell 89 percent.'], llm, ctx: { apiKey: 'k' } });
    assert.match(prompt, /Verified facts:\n- The Dow fell 89 percent\./);
    assert.deepEqual(m.titles.map((t) => t.text), ['When 30 Billion Vanished']);
  });
});
