import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beatsToScenes } from '../../src/pipeline/utils/mapper.ts';
import { ScriptSceneSchema } from '../../src/pipeline/runner/job-runner.ts';
import type { ScriptBeat } from '../../src/lib/script/generate-script.ts';

describe('beatsToScenes Mapper', () => {
  const sampleBeats1Based: ScriptBeat[] = [
    {
      index: 1,
      text: 'Welcome to this deep dive into artificial intelligence.',
      visual_type: 'screen_recording',
      visual_query: 'terminal screen running an AI training loop',
      duration_estimate_seconds: 5,
    },
    {
      index: 2,
      text: 'Notice how transformer models scale with compute.',
      visual_type: 'chart',
      visual_query: 'scaling laws compute vs loss chart',
      duration_estimate_seconds: 8,
    },
    {
      index: 3,
      text: 'In summary, data quality remains paramount.',
      visual_type: 'stock',
      visual_query: 'datacenter server racks glowing blue',
      duration_estimate_seconds: 4,
    },
  ];

  it('maps 1-based beats to engine scenes with exact 1-to-1 scene_number indexing', () => {
    const { scenes, scriptFingerprint } = beatsToScenes(sampleBeats1Based);

    assert.equal(scenes.length, 3);

    // Verify 1-to-1 index alignment (no off-by-one)
    assert.equal(scenes[0].scene_number, 1);
    assert.equal(scenes[1].scene_number, 2);
    assert.equal(scenes[2].scene_number, 3);

    // Verify field mappings
    assert.equal(scenes[0].narration, sampleBeats1Based[0].text);
    assert.equal(scenes[0].visual_prompt, sampleBeats1Based[0].visual_query);
    assert.equal(scenes[0].visual_type, 'screen_recording');
    assert.equal(scenes[0].visual_query, sampleBeats1Based[0].visual_query);
    assert.equal(scenes[0].duration_estimate_seconds, 5);

    // Verify fingerprint
    assert.ok(typeof scriptFingerprint === 'string');
    assert.equal(scriptFingerprint.length, 64); // sha256 hex length
  });

  it('preserves 0-based indexing when beats start at 0 without shifting or off-by-one', () => {
    const sampleBeats0Based: ScriptBeat[] = [
      {
        index: 0,
        text: 'Zero index beat intro',
        visual_type: 'stock',
        visual_query: 'opening shot',
        duration_estimate_seconds: 3,
      },
      {
        index: 1,
        text: 'First index beat body',
        visual_type: 'chart',
        visual_query: 'growth metric',
        duration_estimate_seconds: 6,
      },
    ];

    const { scenes } = beatsToScenes(sampleBeats0Based);

    assert.equal(scenes[0].scene_number, 0);
    assert.equal(scenes[1].scene_number, 1);
    assert.equal(scenes[0].narration, 'Zero index beat intro');
    assert.equal(scenes[1].narration, 'First index beat body');
  });

  it('falls back to beat.text for visual_prompt when visual_query is empty', () => {
    const beatsWithoutQuery: ScriptBeat[] = [
      {
        index: 1,
        text: 'Narration text alone',
        visual_type: 'stock',
        visual_query: '',
        duration_estimate_seconds: 4,
      },
    ];

    const { scenes } = beatsToScenes(beatsWithoutQuery);
    assert.equal(scenes[0].visual_prompt, 'Narration text alone');
  });

  it('produces scenes that satisfy ScriptSceneSchema validation', () => {
    const { scenes } = beatsToScenes(sampleBeats1Based);

    for (const scene of scenes) {
      const parsed = ScriptSceneSchema.safeParse(scene);
      assert.ok(parsed.success, `Scene ${scene.scene_number} failed schema validation: ${JSON.stringify(parsed.error)}`);
    }
  });

  it('computes different fingerprints when scene contents or order change', () => {
    const base = beatsToScenes(sampleBeats1Based);

    // Modify narration
    const modifiedBeats = [
      { ...sampleBeats1Based[0], text: 'A completely different introduction.' },
      sampleBeats1Based[1],
      sampleBeats1Based[2],
    ];
    const modifiedResult = beatsToScenes(modifiedBeats);
    assert.notEqual(base.scriptFingerprint, modifiedResult.scriptFingerprint);

    // Reorder beats
    const reorderedBeats = [
      sampleBeats1Based[1],
      sampleBeats1Based[0],
      sampleBeats1Based[2],
    ];
    const reorderedResult = beatsToScenes(reorderedBeats);
    assert.notEqual(base.scriptFingerprint, reorderedResult.scriptFingerprint);
  });
});
