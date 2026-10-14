import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ShotPlan } from '@/lib/script/generate-script';
import type { WordTiming } from '../tts/word-timings';
import { concatClips, makeColorClip } from './clips';
import { FPS } from './motion/frame-renderer';

export interface ShotSlot {
  shot: ShotPlan;
  startSec: number;
  frames: number;
}

/**
 * Where each shot starts and how many frames it lasts. A shot starts on the first word it
 * covers (from the beat's word timings when available, otherwise in proportion to word counts),
 * the last shot runs to the end of the narration, and boundaries are rounded to whole frames
 * cumulatively so rounding never drifts.
 */
export function computeShotTimeline(
  shots: ShotPlan[],
  words: WordTiming[] | null,
  audioDurationSec: number,
): ShotSlot[] {
  if (shots.length === 0) return [];
  const totalWords = shots.reduce((n, s) => n + s.word_count, 0) || 1;
  const timingsUsable = Boolean(words && words.length >= totalWords);

  const starts = shots.map((shot, i) => {
    if (i === 0) return 0;
    if (timingsUsable) return words![shot.word_start]?.start ?? 0;
    return (shot.word_start / totalWords) * audioDurationSec;
  });

  const boundaries = [...starts.map((s) => Math.round(s * FPS)), Math.max(1, Math.round(audioDurationSec * FPS))];
  // Keep boundaries increasing so every shot gets at least one frame
  for (let i = 1; i < boundaries.length; i++) {
    boundaries[i] = Math.max(boundaries[i], boundaries[i - 1] + 1);
  }
  return shots.map((shot, i) => ({ shot, startSec: boundaries[i] / FPS, frames: boundaries[i + 1] - boundaries[i] }));
}

/** What a rendered shot actually shows and where it came from (for credits and review). */
export interface RenderedShot {
  clipPath: string;
  /** The type actually rendered (may differ from the plan after a fallback). */
  renderedType: string;
  sourceUrl?: string | null;
  license?: string | null;
  licenseSource?: string | null;
  attribution?: string | null;
  note?: string;
  /** Other candidates that passed the relevance check, offered as swaps in the shot editor. */
  alternatives?: ShotAlternative[];
}

/** A footage candidate kept for swapping, with its relevance score when one was checked. */
export interface ShotAlternative {
  id: string;
  provider: string;
  mediaType: 'video' | 'image';
  title?: string;
  thumbnailUrl: string;
  downloadUrl: string;
  pageUrl?: string;
  license?: string;
  attribution?: string;
  score?: number;
}

/** One shot as recorded in the beat's sidecar (`<track>.shots.json`). */
export type ComposedShot = RenderedShot & {
  plannedType: string;
  startSec: number;
  durationSec: number;
  /** Exact length in frames, so a replacement keeps every later cut in place. */
  frames: number;
  /** The director's plan for this shot, so it can be re-rendered on its own. */
  plan: ShotPlan;
  error?: string;
};

export type ShotRenderer = (slot: ShotSlot, clipPath: string) => Promise<RenderedShot>;

export interface ComposeBeatOptions {
  beatIndex: number;
  shots: ShotPlan[];
  words: WordTiming[] | null;
  audioDurationSec: number;
  outputDir: string;
  renderShot: ShotRenderer;
  /** Background color for a shot that can't be rendered at all. */
  fallbackColor?: string;
}

export interface ComposedBeat {
  trackPath: string;
  shots: ComposedShot[];
}

/**
 * Renders a beat as a sequence of shots cut on the narration, joined into one track exactly as
 * long as the narration. A shot that fails to render becomes a plain background so the beat's
 * timing (and every later cut) stays correct.
 */
export async function composeBeatTrack(options: ComposeBeatOptions): Promise<ComposedBeat> {
  const { beatIndex, shots, words, audioDurationSec, outputDir, renderShot, fallbackColor = '#0c0d10' } = options;
  const shotDir = path.join(outputDir, `beat_${beatIndex}_shots`);
  await fs.mkdir(shotDir, { recursive: true });

  const slots = computeShotTimeline(shots, words, audioDurationSec);
  const rendered: ComposedBeat['shots'] = [];
  for (const [i, slot] of slots.entries()) {
    const clipPath = path.join(shotDir, `shot_${i}.mp4`);
    const base = { plannedType: slot.shot.visual_type, startSec: slot.startSec, durationSec: slot.frames / FPS, frames: slot.frames, plan: slot.shot };
    try {
      rendered.push({ ...base, ...(await renderShot(slot, clipPath)) });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[ShotComposer] Beat ${beatIndex} shot ${i} (${slot.shot.visual_type}) failed: ${error}`);
      await makeColorClip(fallbackColor, slot.frames, clipPath);
      rendered.push({ ...base, clipPath, renderedType: 'color', error });
    }
  }

  const trackPath = path.join(outputDir, `visuals_beat_${beatIndex}.mp4`);
  await concatClips(rendered.map((r) => r.clipPath), trackPath);
  await fs.writeFile(`${trackPath}.shots.json`, JSON.stringify({ beatIndex, shots: rendered }, null, 2), 'utf-8');
  return { trackPath, shots: rendered };
}

const LICENSE_STRICTNESS = ['cc_by_sa', 'cc_by', 'royalty_free', 'cc0', 'public_domain', 'own_work', 'purchased'];

/**
 * Summarises shot licenses for the beat's asset record: the most demanding license wins
 * (so attribution duties aren't lost) and every attribution is kept.
 */
export function summarizeLicenses(shots: RenderedShot[]): { license: string | null; attribution: string | null; sources: string[] } {
  const licenses = shots.map((s) => s.license).filter((l): l is string => Boolean(l));
  const license = licenses.sort((a, b) => LICENSE_STRICTNESS.indexOf(a) - LICENSE_STRICTNESS.indexOf(b))[0] ?? null;
  const attributions = [...new Set(shots.map((s) => s.attribution).filter((a): a is string => Boolean(a)))];
  const sources = [...new Set(shots.map((s) => s.sourceUrl).filter((u): u is string => Boolean(u)))];
  return { license, attribution: attributions.length ? attributions.join(' · ') : null, sources };
}
