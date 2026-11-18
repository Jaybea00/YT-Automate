import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUILT_IN_FORMATS } from '../../src/lib/styles/formats.ts';
import { BUILT_IN_NICHES } from '../../src/lib/styles/niches.ts';
import {
  composePack,
  keptStyle,
  LEGACY_SETUPS,
  legacyStyleFor,
  normalizeSetup,
  packForVideo,
  savePack,
  setupForVideo,
  setupKey,
  withComposedStyle,
  type StyleLibrary,
} from '../../src/lib/styles/compose.ts';
import { STYLE_IDS, STYLE_PACKS, narrationPaceFactor, dramaticPauseSec } from '../../src/lib/styles/packs.ts';
import { ALL_THEMES, themeByName } from '../../src/lib/styles/themes.ts';
import { styleTemplate, styleVoice } from '../../src/lib/script/style-templates.ts';
import {
  deleteLibraryItem,
  loadStyleLibrary,
  sanitizeLibrary,
  sanitizeNiche,
  upsertLibraryItem,
} from '../../src/lib/styles/library.ts';
import { briefForAngle } from '../../src/lib/script/angle-brief.ts';
import { normalizeAngles, suggestAnglesWith } from '../../src/lib/script/angles.ts';
import { cleanScripts, deriveVoiceWith, normalizeDerived } from '../../src/lib/styles/derive-voice.ts';
import { estimateCreation, runtimeNote, RUNTIME_PRESETS } from '../../src/lib/script/creation-estimate.ts';
import { creationQueueStatus, enqueueCreation, resetCreationQueue } from '../../src/lib/script/creation-queue.ts';
import { newCreationState, runCreation } from '../../src/lib/script/create-video.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const EMPTY: StyleLibrary = { formats: [], niches: [], voices: [] };

describe('Formats and niches', () => {
  it('every original style maps to a format and niche, and back to itself', () => {
    for (const id of STYLE_IDS) {
      const setup = LEGACY_SETUPS[id];
      assert.ok(BUILT_IN_FORMATS.some((f) => f.id === setup.format), `${id}: format ${setup.format}`);
      assert.ok(BUILT_IN_NICHES.some((n) => n.id === setup.niche), `${id}: niche ${setup.niche}`);
      assert.equal(legacyStyleFor(setup), id, `${id} round-trips`);
      // The composed version keeps what matters about the original
      const { pack } = composePack(setup);
      assert.equal(Boolean(pack.drawn), Boolean(STYLE_PACKS[id].drawn), `${id}: drawn`);
      assert.equal(Boolean(pack.narration), Boolean(STYLE_PACKS[id].narration), `${id}: documentary pacing`);
    }
  });

  it('composes every format with every niche into a usable pack', () => {
    for (const f of BUILT_IN_FORMATS) {
      for (const n of BUILT_IN_NICHES) {
        const { pack, legacyStyle, setup } = composePack({ format: f.id, niche: n.id });
        assert.equal(setup.format, f.id);
        assert.ok(pack.voice.startsWith(f.structure.slice(0, 40)), `${f.id}+${n.id}: structure first`);
        if (n.subject) assert.match(pack.voice, /SUBJECT:/);
        assert.ok(ALL_THEMES.includes(pack.theme), `${f.id}+${n.id}: a real theme`);
        assert.ok(!pack.drawn, 'only the Drawings look draws');
        assert.ok(!STYLE_PACKS[legacyStyle].drawn, `${f.id}+${n.id}: stored style ${legacyStyle} must not wait for drawings`);
        assert.ok(pack.delivery.length > 0);
        assert.match(styleTemplate(legacyStyle, pack)!.systemPrompt, /Return the script as JSON only/);
      }
    }
  });

  it('suggested formats are real formats', () => {
    for (const n of BUILT_IN_NICHES) {
      for (const f of n.suggestedFormats) assert.ok(BUILT_IN_FORMATS.some((x) => x.id === f), `${n.id}: ${f}`);
    }
  });

  it('names qualities, not other creators', () => {
    const texts = [...BUILT_IN_FORMATS.map((f) => `${f.structure} ${f.description} ${f.energy}`), ...BUILT_IN_NICHES.map((n) => `${n.subject} ${n.description} ${n.delivery}`)];
    for (const t of texts) assert.doesNotMatch(t, /Fireship|ColdFusion|Johnny Harris|Vox|Donut|Hagerty|Modern ?MBA/i);
  });

  it('a slow niche slows a normal format, but never a fast one', () => {
    assert.ok(composePack({ format: 'explainer', niche: 'history' }).pack.narration);
    assert.ok(!composePack({ format: 'explainer', niche: 'finance' }).pack.narration);
    assert.ok(!composePack({ format: 'countdown', niche: 'history' }).pack.narration);
    assert.ok(composePack({ format: 'story', niche: 'tech' }).pack.narration, 'a documentary format is always slow');
    const slow = composePack({ format: 'explainer', niche: 'history' });
    assert.ok(narrationPaceFactor(slow.legacyStyle, slow.pack) < 1);
    assert.equal(dramaticPauseSec('tech', slow.pack), 0.8);
  });

  it('the Drawings look draws, with the doodle theme (parchment for faith)', () => {
    const pov = composePack({ format: 'pov', niche: 'space', look: 'drawings' });
    assert.equal(pov.pack.drawn?.secondsPerShot, 3);
    assert.equal(pov.pack.theme.name, 'doodle');
    assert.equal(pov.pack.defaults?.captionPreset, 'doodle');
    assert.equal(pov.legacyStyle, 'stickman_pov');
    assert.match(pov.pack.voice, /stickman drawings/);
    assert.ok(!pov.pack.emphasis?.letterbox);
    const faith = composePack({ format: 'retelling', niche: 'faith', look: 'drawings' });
    assert.equal(faith.pack.theme.name, 'scroll');
    assert.equal(faith.pack.drawn?.secondsPerShot, 4);
    assert.equal(faith.legacyStyle, 'stickman_bible');
    assert.ok(faith.pack.signatureShots?.includes('verse'));
  });

  it('looks, audiences and voices change the pack', () => {
    const collage = composePack({ format: 'explainer', niche: 'geography', look: 'collage' }).pack;
    assert.equal(collage.photoLook, 'collage');
    assert.equal(collage.theme.name, 'vox');
    assert.equal(collage.illustrations, true);
    assert.equal(composePack({ format: 'explainer', niche: 'geography' }).pack.theme.name, 'atlas');
    assert.match(composePack({ format: 'explainer', niche: 'general', audience: 'beginner' }).pack.voice, /complete beginners/);
    const library: StyleLibrary = { ...EMPTY, voices: [{ id: 'v_1', name: 'Mine', description: 'Short punchy lines. Ask the viewer questions.', createdAt: '2026-11-18T00:00:00Z' }] };
    const voiced = composePack({ format: 'story', niche: 'cars', voiceId: 'v_1' }, library).pack;
    assert.match(voiced.voice, /THE CREATOR'S OWN VOICE[\s\S]*Ask the viewer questions/);
    assert.equal(styleVoice('car', voiced), voiced.voice.trim());
  });

  it('unknown ids fall back to the defaults', () => {
    assert.deepEqual(normalizeSetup({ format: 'nope', niche: 'nada', look: 'weird' as never, audience: 'x' as never, voiceId: 'missing' }), {
      format: 'explainer',
      niche: 'general',
      look: 'auto',
      audience: 'general',
      voiceId: null,
    });
    assert.equal(setupKey({ format: 'story', niche: 'history', look: 'drawings', audience: 'beginner' }), 'story+history+look:drawings+aud:beginner');
  });

  it('a video uses its saved pack, else its original style', () => {
    const composed = composePack({ format: 'countdown', niche: 'engineering' });
    const scriptJson = withComposedStyle({ beats: [] }, composed);
    assert.deepEqual((scriptJson as { style_setup: unknown }).style_setup, composed.setup);
    assert.equal((scriptJson as { captions?: { preset: string } }).captions?.preset, 'clean_news');
    assert.equal((scriptJson as { transition?: string }).transition, 'style');
    const video = { style: composed.legacyStyle, script_json: JSON.parse(JSON.stringify(scriptJson)) };
    const pack = packForVideo(video)!;
    assert.equal(pack.theme.name, 'blueprint');
    assert.equal(pack.label, composed.pack.label);
    assert.equal(packForVideo({ style: 'history', script_json: { beats: [] } }), STYLE_PACKS.history);
    assert.deepEqual(setupForVideo(video), composed.setup);
    assert.deepEqual(setupForVideo({ style: 'mystery' }).format, 'investigation');
    assert.deepEqual(keptStyle(scriptJson), { style_setup: composed.setup, style_pack: savePack(composed.pack) });
    assert.deepEqual(keptStyle({ beats: [] }), {});
  });

  it('every theme has its own name', () => {
    assert.equal(new Set(ALL_THEMES.map((t) => t.name)).size, ALL_THEMES.length);
    assert.equal(themeByName('atlas').name, 'atlas');
    assert.equal(themeByName('nope').name, 'documentary');
  });
});

describe('Your own packs and voices', () => {
  let dir: string;
  let file: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'style-lib-'));
    file = path.join(dir, 'style-library.json');
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('saves, edits and deletes formats, niches and voices', async () => {
    assert.deepEqual(await loadStyleLibrary(file), EMPTY, 'no file yet');
    const { item: format } = await upsertLibraryItem('formats', { name: 'Myth vs Fact', structure: 'State a popular myth, then test it against the evidence, beat by beat, and give a verdict.', pacing: 'fast', signatureShots: ['spec_card', 'bogus'] }, file);
    assert.match(format.id, /^cf_/);
    assert.deepEqual((format as { signatureShots: string[] }).signatureShots, ['spec_card']);
    const { item: niche } = await upsertLibraryItem('niches', { name: 'Aviation', theme: 'hazard', fallbackMood: 'tense', suggestedFormats: [format.id, 'story', 'nope'] }, file);
    assert.deepEqual((niche as { suggestedFormats: string[] }).suggestedFormats, [format.id, 'story']);
    const { item: voice } = await upsertLibraryItem('voices', { name: 'Car channel', description: 'Energetic, jokey, lots of questions to the viewer.' }, file);

    // Edits keep the id
    const { item: renamed } = await upsertLibraryItem('niches', { ...niche, name: 'Aviation & Flight' }, file);
    assert.equal(renamed.id, niche.id);

    const library = await loadStyleLibrary(file);
    assert.equal(library.formats.length, 1);
    assert.equal(library.niches[0].name, 'Aviation & Flight');
    const composed = composePack({ format: format.id, niche: niche.id, voiceId: voice.id }, library);
    assert.equal(composed.pack.theme.name, 'hazard');
    assert.match(composed.pack.voice, /popular myth/);
    assert.match(composed.pack.voice, /jokey/);

    assert.equal((await deleteLibraryItem('voices', voice.id, file)).deleted, true);
    assert.equal((await deleteLibraryItem('voices', voice.id, file)).deleted, false);
    assert.equal((await loadStyleLibrary(file)).voices.length, 0);
  });

  it('refuses unusable items and survives a damaged file', async () => {
    await assert.rejects(upsertLibraryItem('formats', { name: '', structure: 'x' }, file), /needs a name/);
    await assert.rejects(upsertLibraryItem('formats', { name: 'Thin', structure: 'too short' }, file), /at least a couple of sentences/);
    await assert.rejects(upsertLibraryItem('voices', { name: 'Me', description: 'hi' }, file), /Describe how you write/);
    assert.throws(() => sanitizeNiche({}), /needs a name/);
    await fs.writeFile(file, '{ not json');
    assert.deepEqual(await loadStyleLibrary(file), EMPTY);
    // A saved item can never shadow a built-in one
    const clash = sanitizeLibrary({ niches: [{ id: 'history', name: 'Fake history' }], voices: [{ name: 'ok', description: 'A real description of a voice.' }, { name: '' }] });
    assert.equal(clash.niches.length, 0);
    assert.equal(clash.voices.length, 1);
  });
});

describe('Find angles', () => {
  it('keeps distinct, honest angles', () => {
    const raw = [
      { title: 'Why the Concorde Really Died', hook: 'It was the fastest way to cross the Atlantic.', angle: 'The economics, not the crash.', kind: 'Mystery', thumbnail: 'Concorde on a runway', thumbnail_text: 'TOO FAST?', why: 'Everyone thinks they know.' },
      { title: 'why the concorde really died', hook: '', angle: '', kind: 'story', thumbnail: '', thumbnail_text: '', why: '' },
      { title: 'The Concorde Lost $1,000,000,000', hook: '', angle: 'Money', kind: 'number', thumbnail: '', thumbnail_text: '', why: '' },
      { title: 'x'.repeat(120), hook: '', angle: '', kind: 'story', thumbnail: '', thumbnail_text: '', why: '' },
    ];
    const angles = normalizeAngles(raw, 'the Concorde');
    assert.deepEqual(angles.map((a) => a.title), ['Why the Concorde Really Died']);
    assert.equal(angles[0].kind, 'mystery');
    const brief = briefForAngle(angles[0]);
    assert.match(brief, /^Angle: The economics, not the crash\./);
    assert.match(brief, /Open with: "It was the fastest way/);
    assert.match(brief, /Thumbnail idea: Concorde on a runway with the text "TOO FAST\?"/);
  });

  it('asks the writer with the format and niche', async () => {
    let prompt = '';
    const llm = {
      kind: 'llm',
      id: 'angles-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async (req: { prompt: string }) => {
        prompt = req.prompt;
        return { data: { angles: [{ title: 'How Singapore Got Rich', hook: 'h', angle: 'a', kind: 'how', thumbnail: 't', thumbnail_text: '', why: 'w' }] }, usage: {} };
      },
    } as unknown as LLMProvider;
    const pack = composePack({ format: 'story', niche: 'geography' }).pack;
    const angles = await suggestAnglesWith(llm, {} as never, { topic: 'Singapore', pack, targetMinutes: 12 });
    assert.equal(angles.length, 1);
    assert.match(prompt, /Format and niche: Story \/ Geography & Geopolitics/);
    assert.match(prompt, /about 12 minutes/);
  });
});

describe('Derive a voice', () => {
  it('needs enough of your own writing', () => {
    assert.throws(() => cleanScripts(['too short']), /at least 150 words/);
    assert.throws(() => cleanScripts('not a list'), /at least 150 words/);
    const long = Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ');
    assert.equal(cleanScripts([long, '', '  ', long, long, long, long, long]).length, 5);
  });

  it('keeps suggestions to real formats and niches', async () => {
    const fixed = normalizeDerived({ name: '"Punchy Me"', description: 'Open cold. Short lines. Ask questions.', format: 'nope', niche: 'history', reasoning: 'Chronological.' }, EMPTY);
    assert.deepEqual([fixed.name, fixed.format, fixed.niche], ['Punchy Me', 'explainer', 'history']);
    assert.throws(() => normalizeDerived({ name: 'x', description: 'hi', format: 'story', niche: 'general', reasoning: '' }, EMPTY), /could not describe/);
    const llm = {
      kind: 'llm',
      id: 'derive-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async (req: { prompt: string }) => {
        assert.match(req.prompt, /SCRIPT 1:/);
        assert.match(req.prompt, /- story: Story/);
        return { data: { name: 'Calm Storyteller', description: 'Long, flowing sentences; end each chapter on a question.', format: 'story', niche: 'faith', reasoning: 'Retells scripture in order.' }, usage: {} };
      },
    } as unknown as LLMProvider;
    const derived = await deriveVoiceWith(llm, {} as never, ['In the beginning...'], EMPTY);
    assert.equal(derived.niche, 'faith');
  });
});

describe('Length presets and estimates', () => {
  it('warns when a length just misses mid-roll ads', () => {
    assert.match(runtimeNote(8)!, /Mid-roll ads need 8:00/);
    assert.match(runtimeNote(7.5)!, /at least 8.5/);
    assert.equal(runtimeNote(12), RUNTIME_PRESETS.find((p) => p.minutes === 12)!.note);
    assert.ok(RUNTIME_PRESETS.some((p) => p.minutes >= 8.5 && p.minutes < 9));
  });

  it('estimates calls and time, scaled by how many topics', () => {
    const one = estimateCreation({ mode: 'ai', minutes: 10 });
    const five = estimateCreation({ mode: 'ai', minutes: 10, count: 5 });
    assert.ok(one.aiCalls >= 8);
    assert.equal(five.aiCalls, one.aiCalls * 5);
    assert.ok(five.minutesHigh > one.minutesHigh);
    assert.ok(estimateCreation({ mode: 'ai', minutes: 10, withBrief: true }).aiCalls < one.aiCalls, 'a brief stops at the outline');
    assert.ok(estimateCreation({ mode: 'ai', minutes: 10, paceFactor: 0.85 }).words < one.words);
  });
});

describe('Background writing', () => {
  it('writes one video at a time, in order', async () => {
    resetCreationQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = enqueueCreation('a', async () => {
      order.push('a:start');
      await gate;
      order.push('a:end');
    });
    const b = enqueueCreation('b', async () => {
      order.push('b');
    });
    enqueueCreation('b', async () => order.push('b again'));
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(creationQueueStatus('a'), { active: true, queued: false, ahead: 0 });
    assert.deepEqual(creationQueueStatus('b'), { active: false, queued: true, ahead: 1 });
    assert.deepEqual(creationQueueStatus('zzz'), { active: false, queued: false, ahead: 0 });
    release();
    await Promise.all([a, b]);
    assert.deepEqual(order, ['a:start', 'a:end', 'b']);
    // A failing run never blocks the next
    await enqueueCreation('c', async () => {
      throw new Error('boom');
    });
    let ran = false;
    await enqueueCreation('d', async () => {
      ran = true;
    });
    assert.ok(ran);
  });

  it('splits pasted text in the background and keeps the composed style', async () => {
    let systemSeen = '';
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock-creation-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async (req) => {
        if (/expert video director and editor/.test(req.system ?? '')) {
          systemSeen = req.prompt;
          return {
            data: {
              title_options: ['The Bridge That Sang'],
              beats: [
                { index: 0, text: 'In 1940 a bridge in Washington began to twist in the wind.', visual_type: 'archive', visual_query: '1940 Tacoma Narrows bridge', duration_estimate_seconds: 5 },
                { index: 1, text: 'Engineers had built it light and slender. Too slender.', visual_type: 'stock', visual_query: 'suspension bridge cables', duration_estimate_seconds: 4 },
              ],
            } as never,
            usage: {},
          };
        }
        throw new Error('no shot planning in this test');
      },
    };
    registerProvider('llm', 'mock-creation-llm', llm);
    const composed = composePack({ format: 'story', niche: 'disasters' });
    const { supabase, db } = createMockSupabase({
      yt_provider_configs: [{ id: 'cfg-create', kind: 'llm', provider: 'mock-creation-llm', label: 'Mock', is_active: true, options: {} }],
      yt_stage_bindings: [{ stage: 'script', provider_config_id: 'cfg-create', max_retries: 0 }],
      videos: [
        {
          id: 'vid-1',
          style: composed.legacyStyle,
          status: 'scripting',
          target_minutes: 3,
          script_json: {
            style_setup: composed.setup,
            style_pack: savePack(composed.pack),
            creation: newCreationState({ mode: 'raw_ai', topic: 'Tacoma Narrows', targetMinutes: 3, rawText: 'In 1940 a bridge...' }),
          },
        },
      ],
    });
    await runCreation(supabase, 'vid-1');
    const video = db.videos[0];
    assert.equal(video.status, 'script_review', video.error_message);
    assert.equal(video.script_json.beats.length, 2);
    assert.equal(video.title, 'The Bridge That Sang');
    assert.equal(video.script_json.creation, undefined, 'the request is gone once written');
    assert.equal(video.script_json.style_pack.theme, 'hazard');
    assert.equal(video.script_json.beat_pause_seconds, 1, 'the documentary pace comes from the composed pack');
    assert.ok(video.target_minutes > 0 && video.target_minutes < 1, 'length comes from the text');
    assert.match(systemSeen, /Style: "Story \/ Disasters & What Went Wrong"/);
  });

  it('keeps the request when writing fails, so it can be retried', async () => {
    const { supabase, db } = createMockSupabase({
      yt_provider_configs: [],
      yt_stage_bindings: [],
      videos: [
        {
          id: 'vid-2',
          style: 'tech',
          status: 'scripting',
          target_minutes: 3,
          script_json: { creation: newCreationState({ mode: 'raw_ai', topic: 'X', targetMinutes: 3, rawText: 'Some text.' }) },
        },
      ],
    });
    await runCreation(supabase, 'vid-2');
    const video = db.videos[0];
    assert.equal(video.status, 'failed');
    assert.match(video.error_message, /Script generation failed/);
    assert.equal(video.script_json.creation.request.topic, 'X');
    assert.ok(video.script_json.creation.error);
  });
});
