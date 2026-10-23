import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addPacingPauses,
  pacingPausePoints,
  pauseFilter,
  sentencePausePoints,
  shiftWordsForPausePoints,
} from '../../src/pipeline/tts/pauses.ts';
import { ttsUnitInput, type TtsSetup } from '../../src/pipeline/tts/voice-beat.ts';
import { dramaticPauseSec } from '../../src/lib/styles/packs.ts';
import { RETENTION_CRAFT } from '../../src/lib/script/style-templates.ts';

const execFileAsync = promisify(execFile);
const w = (word: string, start: number, end: number) => ({ word, start, end });

describe('Pacing marks', () => {
  const narration = 'He fired twice… Silence. Then the crowd ran.';
  const words = [
    w('He', 0, 0.2), w('fired', 0.2, 0.5), w('twice…', 0.5, 1.0),
    w('Silence.', 1.2, 1.8),
    w('Then', 2.0, 2.2), w('the', 2.2, 2.3), w('crowd', 2.3, 2.6), w('ran.', 2.6, 3.0),
  ];

  it('gives an ellipsis a dramatic pause and other sentence ends a breath', () => {
    assert.deepEqual(pacingPausePoints(narration, words, { sentencePauseSec: 0.35, dramaticPauseSec: 0.8 }), [
      { at: 1.1, sec: 0.8 },
      { at: 1.9, sec: 0.35 },
    ]);
  });

  it('marks pauses in fast styles too, where there are no sentence breaths', () => {
    assert.deepEqual(pacingPausePoints(narration, words, { sentencePauseSec: 0, dramaticPauseSec: 0.5 }), [{ at: 1.1, sec: 0.5 }]);
  });

  it('counts a free-standing ellipsis with the word before it', () => {
    const text = 'He fired twice. … Silence.';
    const aligned = [w('He', 0, 0.2), w('fired', 0.2, 0.5), w('twice.', 0.5, 1.0), w('…', 1.05, 1.1), w('Silence.', 1.4, 2.0)];
    assert.deepEqual(pacingPausePoints(text, aligned, { sentencePauseSec: 0.35, dramaticPauseSec: 0.8 }), [{ at: 1.2, sec: 0.8 }]);
    // Older jobs without dramatic pauses keep their sentence pause there
    assert.deepEqual(pacingPausePoints(text, aligned, { sentencePauseSec: 0.35, dramaticPauseSec: 0 }), [{ at: 1.2, sec: 0.35 }]);
  });

  it('matches the old sentence pauses when there are no marks', () => {
    const plain = 'He was twenty-one. He had won everything. What happened next?';
    const timings = [
      w('He', 0, 0.2), w('was', 0.2, 0.4), w('twenty-one.', 0.4, 1.0),
      w('He', 1.2, 1.4), w('had', 1.4, 1.6), w('won', 1.6, 1.8), w('everything.', 1.8, 2.4),
      w('What', 2.6, 2.8), w('happened', 2.8, 3.2), w('next?', 3.2, 3.6),
    ];
    const points = pacingPausePoints(plain, timings, { sentencePauseSec: 0.35, dramaticPauseSec: 0.8 });
    assert.deepEqual(points.map((p) => p.at), sentencePausePoints(plain, timings));
  });

  it('shifts words by the sum of the pauses before them, and pads each piece by its own length', () => {
    const points = [{ at: 1.1, sec: 0.8 }, { at: 1.9, sec: 0.35 }];
    const shifted = shiftWordsForPausePoints(words, points);
    assert.equal(shifted[2].start, 0.5);
    assert.ok(Math.abs(shifted[3].start - 2.0) < 1e-9);
    assert.ok(Math.abs(shifted[7].end - 4.15) < 1e-9);
    const f = pauseFilter([1.1, 1.9], [0.8, 0.35]);
    assert.match(f, /atrim=start=0:end=1\.1,asetpts=PTS-STARTPTS,apad=pad_dur=0\.8/);
    assert.match(f, /apad=pad_dur=0\.35/);
  });

  it('really lengthens the audio by each pause', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marks-'));
    try {
      const mp3 = path.join(dir, 'voice.mp3');
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=24000:duration=3', '-c:a', 'libmp3lame', mp3]);
      const bytes = new Uint8Array(await fs.readFile(mp3));
      const paused = await addPacingPauses({ bytes, narration, providerWords: words, sentencePauseSec: 0.35, dramaticPauseSec: 0.8 });
      assert.equal(paused.pauses, 2);
      const out = path.join(dir, 'out.mp3');
      await fs.writeFile(out, paused.bytes);
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
      assert.ok(Math.abs(Number(stdout.trim()) - 4.15) < 0.12, `3 s + 0.8 s + 0.35 s, got ${stdout.trim()}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('only changes the voicing checkpoint of marked beats on jobs that honour marks', () => {
    const base = { resolved: { provider: { supportsDirection: false } }, voiceId: 'bm_george', pronunciations: [] } as unknown as TtsSetup;
    const marked = { ...base, dramaticPauseSec: 0.8 };
    assert.equal(ttsUnitInput(base, 'He fired twice… Silence.').input.dramaticPauseSec, undefined, 'older jobs unchanged');
    assert.equal(ttsUnitInput(marked, 'He fired twice. Silence.').input.dramaticPauseSec, undefined, 'unmarked beats unchanged');
    assert.equal(ttsUnitInput(marked, 'He fired twice... Silence.').input.dramaticPauseSec, 0.8);
  });

  it('pauses longer in documentary styles and tells the writer how to mark pauses', () => {
    assert.equal(dramaticPauseSec('history'), 0.8);
    assert.equal(dramaticPauseSec('tech'), 0.5);
    assert.match(RETENTION_CRAFT, /Pacing marks: .*ellipsis/);
    assert.match(RETENTION_CRAFT, /He fired twice… Silence\./);
  });
});
