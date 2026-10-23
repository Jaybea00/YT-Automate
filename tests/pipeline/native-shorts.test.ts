import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShortIdeasPrompt,
  createNativeShort,
  draftShortIdeas,
  normalizeShortIdeas,
  shortBrief,
  SHORT_TARGET_MINUTES,
} from '../../src/lib/script/native-shorts.ts';
import { buildUserPrompt, SHORT_FORMAT_RULES } from '../../src/lib/script/generate-script.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const longBeats = [
  { index: 0, text: 'In October 2011, Manchester City travelled to Old Trafford.' },
  { index: 1, text: 'Balotelli scored and lifted his shirt: "Why Always Me?"' },
  { index: 2, text: 'Days earlier, fireworks set his bathroom on fire.' },
];

const rawIdea = (title: string, sources: number[]) => ({
  title,
  hook: 'His bathroom was on fire two days before the biggest game of his life.',
  hook_banner: '"WHY ALWAYS ME?" explained now',
  angle: 'Twist',
  promise: 'What the shirt really meant.',
  source_beats: sources,
});

function setup(id: string, respond: (prompt: string) => unknown) {
  const prompts: string[] = [];
  const llm: LLMProvider = {
    kind: 'llm',
    id,
    generateText: async () => ({ text: '', usage: {} }),
    generateJson: async (req) => {
      prompts.push(req.prompt);
      return { data: respond(req.prompt), usage: {} } as never;
    },
  };
  registerProvider('llm', id, llm);
  const mock = createMockSupabase({
    yt_provider_configs: [{ id: `cfg-${id}`, kind: 'llm', provider: id, label: id, is_active: true }],
    yt_stage_bindings: [{ stage: 'script', provider_config_id: `cfg-${id}`, max_retries: 0 }],
  });
  return { ...mock, prompts };
}

describe('Native Shorts', () => {
  it('asks for self-contained moments with an exact first-line hook', () => {
    const prompt = buildShortIdeasPrompt('Balotelli', longBeats);
    assert.match(prompt, /not a clip of the long video/);
    assert.match(prompt, /hook: the exact first line/);
    assert.match(prompt, /\[1\] Balotelli scored/);
  });

  it('keeps ideas with a hook and real source beats, once each, at most three', () => {
    const ideas = normalizeShortIdeas(
      [
        rawIdea('The Bathroom Fire', [2, 2, 9, 1]),
        rawIdea('the bathroom fire', [2]),
        rawIdea('No Sources', [7]),
        { ...rawIdea('No Hook', [1]), hook: ' ' },
        rawIdea('Two', [0]),
        rawIdea('Three', [1]),
        rawIdea('Four', [2]),
      ],
      [0, 1, 2],
    );
    assert.deepEqual(ideas.map((i) => i.title), ['The Bathroom Fire', 'Two', 'Three']);
    assert.deepEqual(ideas[0].source_beats, [1, 2]);
    assert.equal(ideas[0].hook_banner, 'WHY ALWAYS ME? explained now');
    assert.equal(ideas[0].id, 'short-1');
  });

  it('writes Shorts with their own rules and the hook from the brief', () => {
    const [idea] = normalizeShortIdeas([rawIdea('The Bathroom Fire', [2])], [0, 1, 2]);
    const brief = shortBrief(idea, longBeats);
    assert.match(brief, /^Open with this hook, word for word: "His bathroom/);
    assert.match(brief, /- Days earlier, fireworks/);
    assert.doesNotMatch(brief, /Old Trafford/, 'only the beats the idea draws on');

    const prompt = buildUserPrompt({ topic: idea.title, style: 'sport', targetMinutes: SHORT_TARGET_MINUTES, brief, format: 'short' });
    assert.ok(prompt.includes(SHORT_FORMAT_RULES));
    assert.match(prompt, /Never ask viewers to like, subscribe/);
    assert.doesNotMatch(buildUserPrompt({ topic: 't', style: 'sport', targetMinutes: 8 }), /THIS IS A YOUTUBE SHORT/);
  });

  it('drafts ideas and fails clearly when none are usable', async () => {
    const { supabase } = setup('mock-shorts-ideas', () => ({ ideas: [rawIdea('The Bathroom Fire', [2])] }));
    assert.equal((await draftShortIdeas(supabase, 'Balotelli', longBeats)).length, 1);
    const empty = setup('mock-shorts-empty', () => ({ ideas: [rawIdea('Bad', [42])] }));
    await assert.rejects(draftShortIdeas(empty.supabase, 'Balotelli', longBeats), /No usable Short ideas/);
  });

  it('creates a linked mini video ready for review, with no beat pauses', async () => {
    const shortScript = {
      title_options: ['Fire Before the Derby'],
      beats: [
        { index: 0, text: 'His bathroom was on fire two days before the biggest game of his life.', visual_type: 'stock', visual_query: 'fire', duration_estimate_seconds: 5 },
        { index: 1, text: 'Then he scored at Old Trafford and showed the world a question.', visual_type: 'stock', visual_query: 'stadium', duration_estimate_seconds: 5 },
      ],
    };
    const { supabase, db, prompts } = setup('mock-shorts-make', (prompt) =>
      prompt.includes('THIS IS A YOUTUBE SHORT') ? shortScript : { issues: [], hints: [], shots: [] },
    );
    const [idea] = normalizeShortIdeas([rawIdea('The Bathroom Fire', [2])], [0, 1, 2]);
    const id = await createNativeShort(supabase, { id: 'parent-1', style: 'sport', beats: longBeats }, idea);

    const row = db.videos.find((v: { id: string }) => v.id === id) as Record<string, any>;
    assert.equal(row.status, 'script_review');
    assert.equal(row.target_minutes, SHORT_TARGET_MINUTES);
    assert.equal(row.script_json.format, 'short');
    assert.deepEqual(row.script_json.short, { parent_video_id: 'parent-1', hook_banner: idea.hook_banner });
    assert.equal(row.script_json.beat_pause_seconds, 0);
    assert.equal(row.script_json.title_options[0], 'The Bathroom Fire');
    assert.ok(prompts.some((p) => p.includes('Open with this hook, word for word')));
  });

  it('marks the mini video failed when writing fails', async () => {
    const { supabase, db } = setup('mock-shorts-broken', () => {
      throw new Error('quota');
    });
    const [idea] = normalizeShortIdeas([rawIdea('The Bathroom Fire', [2])], [0, 1, 2]);
    await assert.rejects(createNativeShort(supabase, { id: 'p', style: 'sport', beats: longBeats }, idea), /Writing the Short failed/);
    assert.equal((db.videos[0] as { status: string }).status, 'failed');
  });
});
