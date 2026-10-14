import { loadWordTimings, type WordTiming } from '../tts/word-timings';
import { readSidecar } from '../visuals/shot-editor';
import type { CaptionZone } from './captions';

/** Shots that put the narration (or other text) full screen; captions would just repeat it. */
const FULL_SCREEN_TEXT = new Set(['kinetic_text', 'quote', 'title']);

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The narrator's word timings for each beat, from the voicing stage's sidecars. A sidecar
 * written for different text (the beat was edited after voicing) is ignored, and that beat's
 * captions are spread evenly instead.
 */
export async function loadCaptionWords(
  beats: Array<{ index: number; text: string; audioPath?: string | null }>,
): Promise<Record<number, WordTiming[]>> {
  const out: Record<number, WordTiming[]> = {};
  for (const beat of beats) {
    if (!beat.audioPath) continue;
    const timings = await loadWordTimings(beat.audioPath);
    if (timings && normalize(timings.text) === normalize(beat.text) && timings.words.length) {
      out[beat.index] = timings.words;
    }
  }
  return out;
}

/**
 * Where captions make way, from composed beats' shot lists: hidden while full-screen text is on
 * screen, raised while a lower-third name caption is showing.
 */
export async function captionZonesFromTracks(
  scenes: Array<{ sceneStartMs: number; trackPath: string | null }>,
): Promise<CaptionZone[]> {
  const zones: CaptionZone[] = [];
  for (const scene of scenes) {
    if (!scene.trackPath) continue;
    const sidecar = await readSidecar(scene.trackPath);
    for (const shot of sidecar?.shots ?? []) {
      const startMs = scene.sceneStartMs + shot.startSec * 1000;
      const endMs = startMs + shot.durationSec * 1000;
      if (FULL_SCREEN_TEXT.has(shot.renderedType)) zones.push({ startMs, endMs, kind: 'hide' });
      else if (shot.note?.includes('caption:')) zones.push({ startMs, endMs, kind: 'raise' });
    }
  }
  return zones;
}
