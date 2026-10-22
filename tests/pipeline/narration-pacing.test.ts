import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { addSentencePauses, pauseFilter, sentencePausePoints, shiftWordsForPauses } from '../../src/pipeline/tts/pauses.ts';
import { STYLE_PACKS, narrationPaceFactor, withStyleDefaults } from '../../src/lib/styles/packs.ts';
import { wordBudgetForMinutes } from '../../src/lib/script/script-quality.ts';
import { ttsUnitInput, type TtsSetup } from '../../src/pipeline/tts/voice-beat.ts';

const execFileAsync = promisify(execFile);
const w = (word: string, start: number, end: number) => ({ word, start, end });

describe('Sentence pauses', () => {
  const narration = 'He was twenty-one. He had won everything. What happened next?';
  const words = [
    w('He', 0, 0.2), w('was', 0.2, 0.4), w('twenty-one.', 0.4, 1.0),
    w('He', 1.2, 1.4), w('had', 1.4, 1.6), w('won', 1.6, 1.8), w('everything.', 1.8, 2.4),
    w('What', 2.6, 2.8), w('happened', 2.8, 3.2), w('next?', 3.2, 3.6),
  ];

  it('pauses midway through the gap after each sentence, never after the last', () => {
    assert.deepEqual(sentencePausePoints(narration, words), [1.1, 2.5]);
  });

  it('shifts later words by the pauses before them', () => {
    const shifted = shiftWordsForPauses(words, [1.1, 2.5], 0.35);
    assert.equal(shifted[2].start, 0.4, 'before the first pause: unchanged');
    assert.ok(Math.abs(shifted[3].start - 1.55) < 1e-9, 'after one pause');
    assert.ok(Math.abs(shifted[9].end - 4.3) < 1e-9, 'after two pauses');
  });

  it('builds a split-and-pad filter with no pad on the last piece', () => {
    const f = pauseFilter([1.1, 2.5], 0.35);
    assert.match(f, /asplit=3/);
    assert.equal((f.match(/apad=pad_dur=0\.35/g) ?? []).length, 2);
    assert.match(f, /atrim=start=2\.5,asetpts/);
    assert.match(f, /concat=n=3:v=0:a=1\[out\]/);
  });

  it('really lengthens the audio by the pauses, and leaves it alone without word timings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pace-'));
    try {
      const mp3 = path.join(dir, 'voice.mp3');
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=24000:duration=4', '-c:a', 'libmp3lame', mp3]);
      const bytes = new Uint8Array(await fs.readFile(mp3));

      const unchanged = await addSentencePauses({ bytes, narration, pauseSec: 0.35 });
      assert.equal(unchanged.pauses, 0);
      assert.equal(unchanged.bytes, bytes);

      const paused = await addSentencePauses({ bytes, narration, providerWords: words, pauseSec: 0.35 });
      assert.equal(paused.pauses, 2);
      const out = path.join(dir, 'out.mp3');
      await fs.writeFile(out, paused.bytes);
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
      const duration = Number(stdout.trim());
      assert.ok(Math.abs(duration - 4.7) < 0.12, `4 s + two 0.35 s pauses, got ${duration}`);
      assert.ok(Math.abs(paused.providerWords![9].end - 4.3) < 1e-9, 'word timings moved with the audio');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Documentary pacing in the style packs', () => {
  it('slows story-led styles and the sports documentary, not the explainers', () => {
    for (const id of ['history', 'mystery', 'cinematic', 'story_driven', 'true_crime_pov', 'sport'] as const) {
      assert.ok(STYLE_PACKS[id].narration, id);
    }
    for (const id of ['vox_explainer', 'tech', 'eli5', 'listicle', 'car', 'tech_review'] as const) {
      assert.equal((STYLE_PACKS[id] as { narration?: unknown }).narration, undefined, id);
      assert.equal(narrationPaceFactor(id), 1);
    }
  });

  it('budgets fewer words for paced styles, so videos keep their target length', () => {
    const factor = narrationPaceFactor('history');
    assert.ok(factor > 0.8 && factor < 0.9, `pace factor ${factor}`);
    assert.equal(wordBudgetForMinutes(10).target, 1380);
    assert.equal(wordBudgetForMinutes(10, factor).target, Math.round(1380 * factor));
  });

  it('gives new paced videos a longer pause between beats', () => {
    assert.deepEqual(withStyleDefaults({ beats: [] }, 'history'), { beats: [], captions: { preset: 'vox' }, transition: 'crossfade', beat_pause_seconds: 1 });
    assert.deepEqual(withStyleDefaults({ beats: [], beat_pause_seconds: 0.5 }, 'mystery').beat_pause_seconds, 0.5, 'a chosen pause is kept');
  });

  it('includes pacing in the voicing checkpoint only for paced jobs', () => {
    const base = { resolved: { provider: { supportsDirection: false } }, voiceId: 'bm_george', pronunciations: [] } as unknown as TtsSetup;
    assert.equal(ttsUnitInput(base, 'Hello there.').input.pacing, undefined, 'existing videos keep their checkpoints');
    const paced = { ...base, pacing: { speed: 0.9, sentencePauseSec: 0.35 } };
    assert.deepEqual(ttsUnitInput(paced, 'Hello there.').input.pacing, { speed: 0.9, sentencePauseSec: 0.35 });
  });
});
