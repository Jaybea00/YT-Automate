import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectorResponseSchema,
  alignShotsToNarration,
  enforceShotVariety,
  numbersIn,
  planShotsWith,
  shotCountForBeat,
  verifyShot,
} from '../../src/lib/script/shot-planner.ts';
import { toGeminiResponseSchema } from '../../src/pipeline/providers/llm/gemini.ts';
import type { GeneratedScript, ScriptBeat, ShotPlan } from '../../src/lib/script/generate-script.ts';
import type { LLMProvider, ProviderCallContext } from '../../src/pipeline/providers/types.ts';
import type { ResearchFact } from '../../src/lib/research/types.ts';

const ctx: ProviderCallContext = { apiKey: 'test' };

const beat = (index: number, text: string, extra: Partial<ScriptBeat> = {}): ScriptBeat => ({
  index,
  text,
  visual_type: 'stock',
  visual_query: 'city street',
  duration_estimate_seconds: 5,
  ...extra,
});

const facts: ResearchFact[] = [
  { id: 'F1', claim: 'On Black Tuesday, around $14 billion of stock value was lost.', sourceIds: ['S1'] },
  { id: 'F2', claim: 'The Dow peaked at 381.17 on September 3, 1929, and closed at 41.22 on July 8, 1932.', sourceIds: ['S1'] },
  { id: 'F3', claim: 'Variety ran the headline "Wall St. Lays an Egg" on October 30, 1929.', sourceIds: ['S2'] },
];

describe('Shot planner: shot counts and numbers', () => {
  it('gives about one shot per 4.5 spoken seconds, between 1 and 4', () => {
    assert.equal(shotCountForBeat('Then it broke.'), 1);
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    assert.equal(shotCountForBeat(words(21)), 2); // ~9s
    assert.equal(shotCountForBeat(words(31)), 3); // ~13.5s
    assert.equal(shotCountForBeat(words(200)), 4);
  });

  it('extracts stated numbers at face value and full scale', () => {
    const pool = numbersIn('around $14 billion lost; 12,900,000 shares; the Dow at 381.17');
    for (const n of [14, 14e9, 12_900_000, 381.17]) assert.ok(pool.includes(n), `missing ${n}`);
  });
});

describe('Shot planner: aligning shots to narration words', () => {
  const text =
    'On Black Tuesday, the ticker ran hours behind. Around $14 billion simply vanished that day, and nobody could stop it.';

  it('uses the director\'s covers to place each cut', () => {
    const aligned = alignShotsToNarration(text, [
      { covers: 'On Black Tuesday, the ticker ran hours behind.' },
      { covers: 'Around $14 billion simply vanished that day,' },
      { covers: 'and nobody could stop it.' },
    ]);
    assert.deepEqual(aligned.map((s) => [s.word_start, s.word_count]), [[0, 8], [8, 7], [15, 5]]);
    assert.equal(aligned[1].covers, 'Around $14 billion simply vanished that day,');
  });

  it('falls back to an even split at punctuation when covers don\'t match', () => {
    const aligned = alignShotsToNarration(text, [{ covers: 'something else' }, { covers: 'not in the text' }]);
    assert.equal(aligned.length, 2);
    assert.equal(aligned[0].word_start, 0);
    assert.equal(aligned[0].word_count + aligned[1].word_count, 20);
    assert.match(aligned[0].covers, /[,.]$/, 'cut lands on a phrase boundary');
  });

  it('merges shots too short to hold a visual (under 5 words, ~2s)', () => {
    const aligned = alignShotsToNarration(text, [
      { covers: 'On Black Tuesday, the ticker ran hours behind. Around $14 billion simply vanished that day,' },
      { covers: 'and nobody' },
      { covers: 'could stop it.' },
    ]);
    assert.equal(aligned.length, 1);
    assert.equal(aligned[0].word_count, 20);
  });
});

describe('Shot planner: grounding graphic shots', () => {
  const b = beat(0, 'Around $14 billion vanished on Black Tuesday.', { fact_ids: ['F1'], visual_type: 'archive' });

  it('keeps charts and stats whose numbers are stated, drops invented ones to footage', () => {
    const grounded = verifyShot(
      {
        visual_type: 'chart',
        covers: '',
        visual_query: 'Dow peak to bottom',
        fact_ids: ['F2'],
        chart: { chart_type: 'line', title: 'Dow Jones', labels: ['Sep 1929', 'Jul 1932'], values: [381.17, 41.22] },
      },
      b,
      facts,
    );
    assert.equal(grounded.visual_type, 'chart');

    const invented = verifyShot(
      {
        visual_type: 'chart',
        covers: '',
        visual_query: 'line chart: Dow 1929 -> 1932',
        chart: { chart_type: 'line', title: 'Dow', labels: ['1929', '1930', '1932'], values: [381.17, 250, 41.22] },
      },
      b,
      facts,
    );
    assert.equal(invented.visual_type, 'archive', 'interpolated 250 is not stated anywhere');
    assert.equal(invented.visual_query, 'Dow 1929, 1932');

    assert.equal(
      verifyShot({ visual_type: 'stat', covers: '', visual_query: '$14B', stat: { value: 14, prefix: '$', suffix: ' billion', label: 'lost' } }, b, facts).visual_type,
      'stat',
    );
    assert.equal(
      verifyShot({ visual_type: 'stat', covers: '', visual_query: '$30B', stat: { value: 30, label: 'lost' } }, b, facts).visual_type,
      'archive',
    );
  });

  it('requires quotes in the narration and headlines quoted in research', () => {
    const quoteBeat = beat(1, 'Irving Fisher said stocks had reached "a permanently high plateau" days before.');
    const realQuote = verifyShot(
      { visual_type: 'quote', covers: '', visual_query: 'Fisher quote', quote: { text: 'a permanently high plateau', attribution: 'Irving Fisher' } },
      quoteBeat,
      facts,
    );
    assert.equal(realQuote.visual_type, 'quote');
    const madeUp = verifyShot(
      { visual_type: 'quote', covers: '', visual_query: 'q', quote: { text: 'the market can never fall', attribution: 'Irving Fisher' } },
      quoteBeat,
      facts,
    );
    assert.equal(madeUp.visual_type, 'stock');

    const headline = (h: string) =>
      verifyShot({ visual_type: 'newspaper', covers: '', visual_query: 'Variety', newspaper: { outlet: 'Variety', date: 'Oct 30 1929', headline: h } }, b, facts).visual_type;
    assert.equal(headline('Wall St. Lays an Egg'), 'newspaper');
    assert.equal(headline('Panic Grips Nation'), 'archive');
  });

  it('reads spelled-out numbers and grounds stats from any research fact, recording it', () => {
    assert.ok(numbersIn('about thirty billion dollars').includes(30e9));
    assert.ok(numbersIn('twenty-five percent of three hundred eighty-one').includes(25));
    assert.ok(numbersIn('three hundred eighty-one').includes(381));

    const spelled = beat(3, 'About thirty billion dollars disappeared that autumn.');
    assert.equal(
      verifyShot({ visual_type: 'stat', covers: '', visual_query: '$30B', stat: { value: 30, prefix: '$', suffix: ' billion', label: 'lost' } }, spelled, facts).visual_type,
      'stat',
    );

    const uncited = beat(4, 'Black Tuesday wiped out fortunes.');
    const grounded = verifyShot(
      { visual_type: 'stat', covers: '', visual_query: '$14B', stat: { value: 14, label: 'billion lost' } },
      uncited,
      facts,
    );
    assert.equal(grounded.visual_type, 'stat');
    assert.deepEqual(grounded.fact_ids, ['F1'], 'source fact attached');
  });

  it('never grounds a figure on a date or year in an unrelated fact', () => {
    // F3 mentions "October 30, 1929"; that must not justify a "$30 billion" stat
    const b2 = beat(5, 'Fortunes vanished overnight.');
    assert.equal(
      verifyShot({ visual_type: 'stat', covers: '', visual_query: '$30B', stat: { value: 30, label: 'lost' } }, b2, facts).visual_type,
      'stock',
    );
    assert.equal(
      verifyShot({ visual_type: 'stat', covers: '', visual_query: '1929', stat: { value: 1929, label: 'year' } }, b2, facts).visual_type,
      'stock',
    );
  });

  it('trims a quote card to the words actually spoken or researched', () => {
    const paraphrase = beat(6, 'Irving Fisher told the press stock prices had reached what looked like a "permanently high plateau."');
    const shot = verifyShot(
      {
        visual_type: 'quote',
        covers: '',
        visual_query: 'Fisher quote',
        quote: { text: 'Stock prices have reached what looks like a permanently high plateau.', attribution: 'Irving Fisher' },
      },
      paraphrase,
      facts,
    );
    assert.equal(shot.visual_type, 'quote');
    assert.equal(shot.quote?.text, 'permanently high plateau', 'the passage the narration itself quotes');
  });

  it('never turns the narrator\'s own words into an attributed quote', () => {
    const narration = beat(8, 'For a generation, the lesson was simple: the crowd can be wrong, and the cost lands on everyone.');
    const shot = verifyShot(
      { visual_type: 'quote', covers: '', visual_query: 'q', quote: { text: 'the crowd can be wrong', attribution: 'Historical Consensus' } },
      narration,
      facts,
    );
    assert.equal(shot.visual_type, 'stock');
  });

  it('accepts a headline the narration quotes alongside the outlet', () => {
    const variety = beat(7, 'The next day, the show-business paper Variety summed it up in five words: "Wall St. Lays an Egg."');
    const noResearch: ResearchFact[] = [];
    const ok = verifyShot(
      { visual_type: 'newspaper', covers: '', visual_query: 'Variety', newspaper: { outlet: 'Variety', date: 'Oct 30 1929', headline: 'Wall St. Lays an Egg' } },
      variety,
      noResearch,
    );
    assert.equal(ok.visual_type, 'newspaper');
    const wrongOutlet = verifyShot(
      { visual_type: 'newspaper', covers: '', visual_query: 'NYT', newspaper: { outlet: 'The New York Times', date: 'Oct 30 1929', headline: 'Wall St. Lays an Egg' } },
      variety,
      noResearch,
    );
    assert.equal(wrongOutlet.visual_type, 'stock');
  });

  it('keeps only named places at city scale or larger on maps', () => {
    const mapBeat = beat(2, 'The shock spread from New York to London and Berlin, starting on Wall Street.');
    const shot = verifyShot(
      { visual_type: 'geo_map', covers: '', visual_query: 'map', map: { places: ['New York', 'Wall Street', 'London', 'Tokyo', 'Berlin'], mode: 'spread' } },
      mapBeat,
      facts,
    );
    assert.equal(shot.visual_type, 'geo_map');
    assert.deepEqual(shot.map?.places, ['New York', 'London', 'Berlin']);

    const streetOnly = verifyShot(
      { visual_type: 'geo_map', covers: '', visual_query: 'map: Wall Street', map: { places: ['Wall Street', 'Broad Street'], mode: 'route' } },
      mapBeat,
      facts,
    );
    assert.equal(streetOnly.visual_type, 'stock');
  });
});

describe('Shot planner: variety and orchestration', () => {
  const shot = (visual_type: ShotPlan['visual_type']): ShotPlan => ({
    visual_type,
    visual_query: 'line chart: x',
    covers: 'a b c',
    word_start: 0,
    word_count: 3,
  });

  it('downgrades a third same-type graphic in a row, across beats', () => {
    const beats = enforceShotVariety([
      { ...beat(0, 'a b c d e f'), shots: [shot('chart'), shot('chart')] },
      { ...beat(1, 'a b c d e f'), shots: [shot('chart'), shot('stat')] },
    ]);
    assert.deepEqual(beats.flatMap((b) => b.shots!.map((s) => s.visual_type)), ['chart', 'chart', 'stock', 'stat']);
  });

  it('converts the director schema for Gemini constrained output', () => {
    const schema = toGeminiResponseSchema(DirectorResponseSchema) as any;
    assert.ok(schema, 'schema must convert, or Gemini can return malformed JSON');
    const shotSchema = schema.properties.beats.items.properties.shots.items;
    assert.equal(shotSchema.properties.chart.nullable, true);
    assert.ok(shotSchema.properties.visual_type.enum.includes('stat'));
  });

  it('plans in batches, carries recent shot types forward, and survives a failed batch', async () => {
    const prompts: string[] = [];
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock-director',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async (req) => {
        prompts.push(req.prompt);
        if (prompts.length === 2) throw new Error('capacity');
        const indexes = [...req.prompt.matchAll(/^Beat (\d+) \(/gm)].map((m) => Number(m[1]));
        return {
          data: { beats: indexes.map((index) => ({ index, shots: [{ visual_type: 'archive', covers: '', visual_query: `scene ${index}` }] })) } as never,
          usage: {},
        };
      },
    };

    const script: GeneratedScript = {
      title_options: ['t'],
      beats: Array.from({ length: 26 }, (_, i) => beat(i, 'One two three four five six seven.')),
    };
    const result = await planShotsWith(llm, ctx, script, 'topic');

    assert.equal(prompts.length, 3, '26 beats -> batches of 12, 12, 2');
    assert.match(prompts[1], /shots just before this batch were: archive, archive, archive/);
    assert.equal(result.beats[0].shots?.[0].visual_query, 'scene 0');
    assert.equal(result.beats[12].shots, undefined, 'failed batch keeps beat-level visuals');
    assert.equal(result.beats[25].shots?.length, 1);
  });
});
