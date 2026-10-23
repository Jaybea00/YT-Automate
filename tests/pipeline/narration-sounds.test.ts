import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildMomentsPrompt,
  maxMoments,
  momentCues,
  narrationHash,
  normalizeMoments,
  planSoundMoments,
  triggerWordIndex,
} from '../../src/pipeline/assembly/sound-moments.ts';
import { REAL_SOUNDS, fetchFromFreesound, findSourceFile, freesoundSearchUrl } from '../../src/pipeline/assembly/real-sfx.ts';
import { applySoundDesign } from '../../src/pipeline/assembly/sound-design.ts';
import { registerProvider } from '../../src/pipeline/providers/registry.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);
const w = (word: string, start: number, end: number) => ({ word, start, end });

const beats = [
  { index: 0, text: 'Sarajevo, 28 June 1914. The motorcade takes a wrong turn.' },
  { index: 1, text: 'Princip steps forward and fires twice… Silence.' },
  { index: 2, text: 'The markets exploded the next morning.' },
];

describe('Narration-triggered sounds', () => {
  it('asks only for sounds the story makes, sparingly, from the catalog', () => {
    const prompt = buildMomentsPrompt(beats, 'history');
    assert.match(prompt, /Never for metaphors/);
    assert.match(prompt, /at most 2 sounds/);
    assert.match(prompt, /- gunshot: Gunshot/);
    assert.match(prompt, /\[1\] Princip steps forward/);
  });

  it('finds the trigger word, counting free-standing punctuation like the word timings do', () => {
    assert.equal(triggerWordIndex(beats[1].text, 'fires'), 4);
    assert.equal(triggerWordIndex(beats[1].text, 'Fires twice'), 4);
    assert.equal(triggerWordIndex('He fired. … Then BANG!', 'bang'), 4);
    assert.equal(triggerWordIndex(beats[1].text, 'shoots'), -1);
  });

  it('keeps real catalog sounds on words that exist, one per beat, within the cap', () => {
    const moments = normalizeMoments(
      [
        { beat_index: 1, trigger: 'fires', sound: 'Gunshot', intensity: 'STRONG' },
        { beat_index: 1, trigger: 'Silence', sound: 'heartbeat' },
        { beat_index: 2, trigger: 'exploded', sound: 'laser' },
        { beat_index: 0, trigger: 'nowhere', sound: 'siren' },
        { beat_index: 0, trigger: 'motorcade', sound: 'car_engine', intensity: 'soft' },
      ],
      beats,
    );
    assert.deepEqual(moments, [
      { beat_index: 0, trigger: 'motorcade', sound: 'car_engine', intensity: 'soft' },
      { beat_index: 1, trigger: 'fires', sound: 'gunshot', intensity: 'strong' },
    ]);
    assert.equal(maxMoments(beats), 2);
  });

  it('lands each sound at its word, skipping moments without timings or a recording', () => {
    const cues = momentCues(
      [
        { beat_index: 1, trigger: 'fires', sound: 'gunshot', intensity: 'normal' },
        { beat_index: 0, trigger: 'motorcade', sound: 'car_engine', intensity: 'soft' },
        { beat_index: 2, trigger: 'exploded', sound: 'explosion', intensity: 'normal' },
      ],
      beats,
      {
        1: [w('Princip', 0, 0.4), w('steps', 0.4, 0.7), w('forward', 0.7, 1.1), w('and', 1.1, 1.2), w('fires', 1.25, 1.6), w('twice…', 1.6, 2), w('Silence.', 2.8, 3.3)],
        0: [w('Sarajevo,', 0, 0.6)],
      },
      { 0: 500, 1: 10_000, 2: 20_000 },
      { gunshot: '/sfx/gunshot.wav', car_engine: '/sfx/car.wav' },
    );
    assert.equal(cues.length, 1, 'beat 0 has no timing for its word, beat 2 has no recording');
    assert.deepEqual(cues[0], { atMs: 11_250, sound: 'real:gunshot', file: '/sfx/gunshot.wav', gain: REAL_SOUNDS.gunshot.gain });
  });

  it('plans with the model and fingerprints the narration it planned for', async () => {
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock-moments-llm',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => ({ data: { moments: [{ beat_index: 1, trigger: 'fires', sound: 'gunshot' }] }, usage: {} }) as never,
    };
    registerProvider('llm', 'mock-moments-llm', llm);
    const { supabase } = createMockSupabase({
      yt_provider_configs: [{ id: 'cfg-moments', kind: 'llm', provider: 'mock-moments-llm', label: 'm', is_active: true }],
      yt_stage_bindings: [{ stage: 'script', provider_config_id: 'cfg-moments', max_retries: 0 }],
    });
    const plan = await planSoundMoments(supabase, beats, 'history');
    assert.equal(plan.textHash, narrationHash(beats));
    assert.notEqual(narrationHash([{ index: 1, text: 'Edited.' }]), plan.textHash);
    assert.deepEqual(plan.moments.map((m) => m.sound), ['gunshot']);
  });

  it('searches Freesound for CC0 only, and uses the creator\'s newest file first', async () => {
    const url = freesoundSearchUrl(REAL_SOUNDS.whistle, 'KEY');
    assert.match(new URL(url).searchParams.get('filter')!, /license:"Creative Commons 0"/);
    assert.match(url, /token=KEY/);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'realsfx-'));
    try {
      await fs.mkdir(path.join(dir, 'whistle'));
      await fs.writeFile(path.join(dir, 'whistle', 'old.wav'), 'a');
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(path.join(dir, 'whistle', 'new.mp3'), 'b');
      await fs.writeFile(path.join(dir, 'whistle', 'notes.txt'), 'c');
      assert.equal(path.basename((await findSourceFile('whistle', dir))!), 'new.mp3');
      assert.equal(await findSourceFile('gunshot', dir), null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('downloads the best CC0 Freesound match and records its source', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freesound-'));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const u = String(input);
      if (u.includes('/apiv2/search/')) {
        return new Response(
          JSON.stringify({
            results: [
              { id: 1, name: 'cc-by', username: 'a', license: 'http://creativecommons.org/licenses/by/4.0/', duration: 1, previews: { 'preview-hq-mp3': 'https://cdn/1.mp3' } },
              { id: 2, name: 'whistle', username: 'ref', license: 'http://creativecommons.org/publicdomain/zero/1.0/', duration: 1, previews: { 'preview-hq-mp3': 'https://cdn/2.mp3' } },
            ],
          }),
        );
      }
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    try {
      const file = await fetchFromFreesound('whistle', 'KEY', dir);
      assert.equal(path.basename(file!), 'freesound-2.mp3', 'the CC-BY result is skipped');
      const note = JSON.parse(await fs.readFile(`${file}.json`, 'utf-8'));
      assert.equal(note.author, 'ref');
      assert.equal(note.url, 'https://freesound.org/s/2/');
    } finally {
      globalThis.fetch = realFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('mixes a recorded sound from its file alongside library sounds', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mixreal-'));
    try {
      const program = path.join(dir, 'program.mp4');
      const bang = path.join(dir, 'bang.wav');
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30', '-f', 'lavfi', '-i', 'sine=f=300:r=48000,volume=0.3', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', program]);
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=0.4:c=white:r=48000', '-ac', '1', bang]);
      const out = path.join(dir, 'out.mp4');
      const result = await applySoundDesign({
        videoPath: program,
        outputPath: out,
        cues: [
          { atMs: 500, sound: 'tick', gain: 0.5 },
          { atMs: 1500, sound: 'real:gunshot', file: bang, gain: 1.6 },
        ],
      });
      assert.equal(result.cueCount, 2);
      assert.ok((await fs.stat(out)).size > 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
