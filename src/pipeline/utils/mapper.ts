import type { ScriptBeat } from '@/lib/script/generate-script';
import { ScriptScene } from '../runner/job-runner';
import { computeScriptFingerprint } from './hash';

export interface MappedScenesResult {
  scenes: ScriptScene[];
  scriptFingerprint: string;
}

/**
 * Maps front-door ScriptBeat[] to engine ScriptScene[].
 *
 * Indexing contract:
 * - The front door produces beats with `beat.index`.
 * - The pipeline engine sets `scene_number = beat.index` directly.
 * - The pipeline's fine-grained unit checkpointing (`yt_job_units.unit_index`)
 *   and assembly asset lookup are keyed directly by `scene_number`.
 * - Because `scene_number` is assigned directly from `beat.index` with no +1 / -1
 *   shift, the mapping is guaranteed 1-to-1 and cannot be off by one, regardless
 *   of whether the beats originate as 0-indexed or 1-indexed.
 *
 * Extra optional fields (visual_type, visual_query, duration_estimate_seconds)
 * are carried forward so downstream stages (e.g. Part C visuals) have access to them.
 */
export function beatsToScenes(beats: ScriptBeat[]): MappedScenesResult {
  if (!Array.isArray(beats)) {
    throw new Error('beatsToScenes: expected an array of ScriptBeat');
  }

  const scenes: ScriptScene[] = beats.map((beat) => ({
    scene_number: beat.index,
    narration: beat.text,
    visual_prompt: beat.visual_query ? beat.visual_query : beat.text,
    visual_type: beat.visual_type,
    visual_query: beat.visual_query,
    duration_estimate_seconds: beat.duration_estimate_seconds,
  }));

  const scriptFingerprint = computeScriptFingerprint(scenes);

  return {
    scenes,
    scriptFingerprint,
  };
}
