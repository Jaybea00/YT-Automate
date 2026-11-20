import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { directionWithMood, moodSpeed } from '../../src/lib/script/delivery-moods.ts';
import { applyVoicePlan, buildCastPrompt, buildMoodPrompt, changedBeats, findInBeat, normalizeCasting, normalizeMoods, planForApproval, revalidateCasting } from '../../src/lib/script/voice-plan.ts';
import { scriptTextSignature } from '../../src/lib/script/script-quality.ts';
import { joinSegments, normalizeBeatVoice, setupForBeat, splitNarration, voiceKeyOf, type TtsSetup } from '../../src/pipeline/tts/voice-beat.ts';
import { takeBadness } from '../../src/pipeline/tts/retake.ts';
import { Ai33TtsProvider, parseAi33Transcript } from '../../src/pipeline/providers/tts/ai33.ts';
import type { ProviderCallContext } from '../../src/pipeline/providers/types.ts';

const setup = (over: Partial<TtsSetup> = {}, supportsDirection = false): TtsSetup =>
  ({
    resolved: { provider: { kind: 'tts', id: 'p', supportsDirection, synthesize: async () => ({ bytes: new Uint8Array(), mimeType: 'audio/mpeg', usage: {} }) }, ctx: { apiKey: '', options: {} }, maxRetries: 1, configId: 'c1', providerId: 'p', options: {} },
    voiceId: 'v1',
    pronunciations: [],
    ...over,
  }) as unknown as TtsSetup;

describe('beat voice settings', () => {
  it('keeps valid moods, takes and character parts, and drops bad ones', () => {
    const v = normalizeBeatVoice({
      mood: 'tense',
      take: { path: 'C:/t.mp3', durationMs: 1200.4, spokenText: 'hi', voiceKey: 'k', words: [{ word: 'hi', start: 0, end: 0.4 }, { word: 7 }] },
      parts: [{ text: 'I will return', narratorId: 'n1', speaker: 'MacArthur' }, { text: '', narratorId: 'n2' }, { text: 'x', narratorId: 'bad id!' }],
    });
    assert.equal(v?.mood, 'tense');
    assert.deepEqual(v?.take, { path: 'C:/t.mp3', durationMs: 1200, spokenText: 'hi', voiceKey: 'k', words: [{ word: 'hi', start: 0, end: 0.4 }] });
    assert.deepEqual(v?.parts, [{ text: 'I will return', narratorId: 'n1', speaker: 'MacArthur' }]);
    assert.equal(normalizeBeatVoice({ mood: 'neutral' }), null);
    assert.equal(normalizeBeatVoice({ mood: 'angry' }), null);
  });
});

describe('delivery moods', () => {
  it('adds the mood to the base direction and changes the pace', () => {
    assert.equal(directionWithMood('Calm documentary narrator.', 'tense'), 'Calm documentary narrator. For this line: Tense and controlled, building suspense, slightly lower.');
    assert.equal(directionWithMood(undefined, 'neutral'), undefined);
    assert.equal(moodSpeed('reveal'), 0.88);
    assert.equal(moodSpeed(undefined), 1);
  });

  it('applies a mood as pace for every voice and as direction only for voices that take it', async () => {
    const base = setup({ pacing: { speed: 1, sentencePauseSec: 0.3 } });
    const plain = await setupForBeat({} as never, base, { mood: 'quiet' });
    assert.equal(plain.pacing?.speed, 0.9);
    assert.equal(plain.direction, undefined);
    const directed = await setupForBeat({} as never, setup({}, true), { mood: 'quiet' });
    assert.match(directed.direction ?? '', /sombre/);
    // A pace set by hand wins over the mood's
    assert.equal((await setupForBeat({} as never, base, { mood: 'quiet', speed: 1.2 })).pacing?.speed, 1.2);
  });

  it('keeps moods to real beats and allows at most three reveals', () => {
    const beats = [0, 1, 2, 3, 4].map((index) => ({ index, text: 't' }));
    const moods = normalizeMoods([0, 1, 2, 3].map((index) => ({ index, mood: 'reveal' })).concat([{ index: 9, mood: 'tense' }, { index: 4, mood: 'shouty' }]), beats);
    assert.deepEqual([...moods], [[0, 'reveal'], [1, 'reveal'], [2, 'reveal']]);
    assert.match(buildMoodPrompt(beats, 'Story / History'), /YouTube Story \/ History video/);
  });
});

describe('re-takes', () => {
  it('weighs missing and broken words most', () => {
    assert.equal(takeBadness([{ type: 'skipped' }, { type: 'added' }]), 4);
    assert.ok(takeBadness([{ type: 'garbled' }]) > takeBadness([{ type: 'mispronounced' }]));
    assert.equal(takeBadness([]), 0);
  });

  it('ties a take to its voice, delivery and pace', () => {
    const a = setup({ pacing: { speed: 1, sentencePauseSec: 0.3 } });
    assert.equal(voiceKeyOf(a), voiceKeyOf(setup({ pacing: { speed: 1, sentencePauseSec: 0.3 } })));
    assert.notEqual(voiceKeyOf(a), voiceKeyOf({ ...a, voiceId: 'v2' }));
    assert.notEqual(voiceKeyOf(a), voiceKeyOf({ ...a, pacing: { speed: 0.9, sentencePauseSec: 0.3 } }));
    // Direction only matters for voices that use it
    assert.equal(voiceKeyOf(a), voiceKeyOf({ ...a, direction: 'whisper' }));
  });
});

describe('character voices', () => {
  const narrators = [
    { id: 'main', name: 'Heart', voice_id: 'af_heart', provider: 'openai-compatible' },
    { id: 'n2', name: 'George', voice_id: 'bm_george', provider: 'openai-compatible' },
  ];
  const beats = [{ index: 0, text: 'He wrote home: "I am coming back before the snow falls." Then silence.' }];

  it('splits a beat around its quotes, in order, skipping quotes no longer in the text', () => {
    const parts = [{ text: 'I am coming back before the snow falls.', narratorId: 'n2' }, { text: 'not here', narratorId: 'n2' }];
    assert.deepEqual(
      splitNarration(beats[0].text, parts).map((s) => [s.text, s.part?.narratorId ?? 'narrator']),
      [['He wrote home: "', 'narrator'], ['I am coming back before the snow falls.', 'n2'], ['" Then silence.', 'narrator']],
    );
    assert.deepEqual(splitNarration('plain', undefined), [{ text: 'plain' }]);
  });

  it('never sends a lone closing quote mark to the voice', () => {
    const quote = "I think it's highly unlikely Cooper survived the jump.";
    assert.deepEqual(
      splitNarration(`Carr concluded, "${quote}"`, [{ text: quote, narratorId: 'n2' }]).map((s) => s.text),
      ['Carr concluded, "', quote],
    );
    assert.deepEqual(splitNarration(`"${quote}"`, [{ text: quote, narratorId: 'n2' }]).map((s) => s.text), [quote]);
  });

  it('keeps only castings that can be voiced', () => {
    const casting = normalizeCasting(
      {
        speakers: [
          { name: 'Soldier', narrator_id: 'n2', why: '' },
          { name: 'Narrator twin', narrator_id: 'main', why: '' },
          { name: 'Ghost', narrator_id: 'nope', why: '' },
        ],
        lines: [
          { beat_index: 0, quote: '"I am coming back before the snow falls."', speaker: 'Soldier' },
          { beat_index: 0, quote: 'invented words not in the beat', speaker: 'Soldier' },
          { beat_index: 0, quote: 'Then silence.', speaker: 'Narrator twin' },
          { beat_index: 0, quote: 'coming back', speaker: 'Soldier' },
        ],
      },
      beats,
      narrators,
      'main',
    );
    assert.deepEqual(casting, { speakers: [{ name: 'Soldier', narratorId: 'n2' }], lines: [{ beat_index: 0, quote: 'I am coming back before the snow falls.', speaker: 'Soldier' }] });
    assert.match(buildCastPrompt(beats, narrators, 'Heart, openai-compatible'), /never the main narrator itself \(Heart, openai-compatible\)/);
  });

  it('matches quotes whatever their apostrophes, returning the beat\'s own wording', () => {
    assert.equal(findInBeat('He cried: “Don’t die! Stay alive!”', "Don't die! Stay alive!"), 'Don’t die! Stay alive!');
    assert.equal(findInBeat('nothing here', 'Don\'t'), null);
    assert.match(buildCastPrompt(beats, narrators), /an English script needs an English voice/);
  });

  it('moves saved character lines to wherever their quote now is, dropping lost ones', () => {
    const saved = {
      speakers: [{ name: 'Soldier', narratorId: 'n2' }, { name: 'Wife', narratorId: 'n3' }],
      lines: [
        { beat_index: 0, quote: 'I am coming back before the snow falls.', speaker: 'Soldier' },
        { beat_index: 1, quote: 'Please write every week to me.', speaker: 'Wife' },
      ],
    };
    // A beat was added in front, and the wife's line was cut
    const edited = [{ index: 0, text: 'New opening.' }, { index: 1, text: beats[0].text }];
    assert.deepEqual(revalidateCasting(saved, edited), { speakers: [{ name: 'Soldier', narratorId: 'n2' }], lines: [{ beat_index: 1, quote: 'I am coming back before the snow falls.', speaker: 'Soldier' }] });
  });

  it('applies a saved plan as it is when the script hasn\'t changed (no model call)', async () => {
    const saved = { basedOn: scriptTextSignature(beats), moods: [[0, 'tense']] as Array<[number, 'tense']>, casting: { speakers: [], lines: [] }, madeAt: '' };
    const plan = await planForApproval({} as never, 'v', beats, saved);
    assert.equal(plan.source, 'saved');
    assert.deepEqual([...plan.moods!], [[0, 'tense']]);
  });

  it('saves the plan into the beats\' voice settings and reports what changed', () => {
    const before = { 0: { speed: 1.1, mood: 'tense' }, 2: { mood: 'quiet' } };
    const after = applyVoicePlan(before, {
      moods: new Map([[0, 'neutral'], [1, 'excited']] as const),
      casting: { speakers: [{ name: 'Soldier', narratorId: 'n2' }], lines: [{ beat_index: 1, quote: 'hold the line', speaker: 'Soldier' }] },
    });
    assert.deepEqual(after, { 0: { speed: 1.1 }, 1: { mood: 'excited', parts: [{ text: 'hold the line', narratorId: 'n2', speaker: 'Soldier' }] } });
    assert.deepEqual(changedBeats(before, after, 3), [0, 1, 2]);
    assert.deepEqual(changedBeats(after, after, 3), []);
  });

  it('joins voiced pieces with a short gap and shifts their word timings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-'));
    try {
      const tone = (f: string, sec: number) => {
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=f=440:d=${sec}`, '-c:a', 'libmp3lame', path.join(dir, f)]);
        return new Uint8Array(fs.readFileSync(path.join(dir, f)));
      };
      const joined = await joinSegments([
        { bytes: tone('a.mp3', 1), words: [{ word: 'one', start: 0, end: 0.5 }] },
        { bytes: tone('b.mp3', 1), words: [{ word: 'two', start: 0.1, end: 0.6 }] },
      ]);
      fs.writeFileSync(path.join(dir, 'out.mp3'), joined.bytes);
      const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(dir, 'out.mp3')]).toString());
      assert.ok(dur > 2.1 && dur < 2.35, `duration ${dur}`);
      assert.equal(joined.words?.[1].word, 'two');
      assert.ok(joined.words![1].start > 1.2 && joined.words![1].start < 1.4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ai33', () => {
  it('reads word timings in seconds or milliseconds, flat or in segments', () => {
    assert.deepEqual(parseAi33Transcript([{ word: 'Hi', start: 0, end: 0.3 }, { word: 'there', start: 0.3, end: 0.7 }]), [
      { word: 'Hi', start: 0, end: 0.3 },
      { word: 'there', start: 0.3, end: 0.7 },
    ]);
    const ms = parseAi33Transcript({ segments: [{ text: 'Hi there', words: [{ text: 'Hi', start_time: 0, end_time: 300 }, { text: 'there', start_time: 300, end_time: 4000 }] }] });
    assert.deepEqual(ms, [{ word: 'Hi', start: 0, end: 0.3 }, { word: 'there', start: 0.3, end: 4 }]);
    assert.equal(parseAi33Transcript({ nothing: true }), undefined);
  });

  it('starts a task, polls it until done, and downloads the audio', async () => {
    const calls: string[] = [];
    let polls = 0;
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/v3/text-to-speech')) {
        const body = init!.body as FormData;
        assert.equal(body.get('voice_id'), 'elevenlabs_abc');
        assert.equal(body.get('speed'), '1.5');
        assert.equal((init!.headers as Record<string, string>)['xi-api-key'], 'KEY');
        return Response.json({ success: true, task_id: 't1' });
      }
      if (u.endsWith('/v1/task/t1')) return Response.json(++polls < 2 ? { status: 'doing' } : { status: 'done', metadata: { audio_url: 'https://cdn/a.mp3', json_url: 'https://cdn/a.json' } });
      if (u === 'https://cdn/a.mp3') return new Response(new Uint8Array([1, 2, 3]));
      if (u === 'https://cdn/a.json') return Response.json([{ word: 'a', start: 0, end: 1 }, { word: 'b', start: 1, end: 2 }]);
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const provider = new Ai33TtsProvider(fake, async () => {});
    const ctx: ProviderCallContext = { apiKey: 'KEY', options: {} };
    const result = await provider.synthesize({ text: 'hello', voiceId: 'elevenlabs_abc', format: 'mp3', speed: 2 }, ctx);
    assert.deepEqual([...result.bytes], [1, 2, 3]);
    assert.equal(result.words?.length, 2);
    assert.equal(calls.filter((c) => c.includes('/v1/task/')).length, 2);
  });

  it('reports a failed task', async () => {
    const fake = (async (url: string | URL) =>
      String(url).endsWith('/v3/text-to-speech') ? Response.json({ task_id: 't2' }) : Response.json({ status: 'error', error_message: 'Not enough credits' })) as typeof fetch;
    await assert.rejects(new Ai33TtsProvider(fake, async () => {}).synthesize({ text: 'x', voiceId: 'v', format: 'mp3' }, { apiKey: 'K', options: {} }), /Not enough credits/);
  });

  it('lists voices from the chosen engines', async () => {
    const fake = (async (url: string | URL) => {
      const engine = new URL(String(url)).searchParams.get('provider');
      return Response.json({ data: [{ voice_id: `${engine}_1`, name: 'Ann', language: 'en', gender: 'Female', preview_url: null }] });
    }) as typeof fetch;
    const voices = await new Ai33TtsProvider(fake).listVoices({ apiKey: 'K', options: { voiceProviders: ['fishaudio', 'edge'] } });
    assert.deepEqual(voices.map((v) => [v.id, v.name]), [['fishaudio_1', 'Ann (fishaudio · en · Female)'], ['edge_1', 'Ann (edge · en · Female)']]);
  });
});
