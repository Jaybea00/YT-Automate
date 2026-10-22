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
  /** The footage source shown (so the shot can be re-rendered at another length). */
  chosen?: ShotAlternative;
  /** Footage made from a still photo rather than moving video. */
  still?: boolean;
  /** Shows something other than planned because the plan couldn't be filled (e.g. no footage found). */
  fallback?: boolean;
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
  /** Picture before the narration starts (the cut lands before the voice); the first shot runs this much longer. */
  leadInSec?: number;
  /** Picture after the narration ends; the last shot keeps moving through it instead of freezing. */
  tailSec?: number;
  /**
   * Re-renders a footage shot's source over a longer slot. When given, a shot that fell back
   * (no footage found, or failed) is covered by its footage neighbour in the beat instead.
   */
  extendShot?: (neighbour: ComposedShot, slot: ShotSlot, clipPath: string) => Promise<RenderedShot>;
}

/** A footage shot held over a missing neighbour stays under this, so it doesn't drag. */
export const MAX_EXTENDED_SHOT_SEC = 9;

const isGap = (s: ComposedShot) => Boolean(s.fallback) || s.renderedType === 'color';
const canCover = (s: ComposedShot | undefined, gap: ComposedShot): s is ComposedShot =>
  Boolean(s && (s.renderedType === 'stock' || s.renderedType === 'archive') && s.chosen && !isGap(s)) &&
  s!.frames + gap.frames <= Math.round(MAX_EXTENDED_SHOT_SEC * FPS);

/**
 * Lets footage cover the beat's gaps the way an editor would: a shot that fell back to a text
 * card or plain background is merged into the footage shot before it (or else after it), whose
 * source is re-rendered across both slots. Gaps without a footage neighbour, or where the merged
 * shot would run longer than MAX_EXTENDED_SHOT_SEC, stay as they are.
 */
export async function coverGaps(
  shots: ComposedShot[],
  extend: NonNullable<ComposeBeatOptions['extendShot']>,
  shotDir: string,
  beatIndex: number,
): Promise<ComposedShot[]> {
  const out = [...shots];
  for (let i = 0; i < out.length; i++) {
    const gap = out[i];
    if (!isGap(gap)) continue;
    const n = canCover(out[i - 1], gap) ? i - 1 : canCover(out[i + 1], gap) ? i + 1 : -1;
    if (n < 0) continue;
    const neighbour = out[n];
    const [first, second] = n < i ? [neighbour, gap] : [gap, neighbour];
    const plan: ShotPlan = {
      ...neighbour.plan,
      covers: `${first.plan.covers} ${second.plan.covers}`.trim(),
      word_start: first.plan.word_start,
      word_count: first.plan.word_count + second.plan.word_count,
    };
    const slot: ShotSlot = { shot: plan, startSec: first.startSec, frames: first.frames + second.frames };
    const at = Math.min(n, i);
    try {
      const rendered = await extend(neighbour, slot, path.join(shotDir, `shot_${at}_held.mp4`));
      const why = gap.renderedType === 'color' ? 'it could not be rendered' : 'no footage was found for it';
      out.splice(at, 2, {
        ...rendered,
        plannedType: neighbour.plannedType,
        startSec: slot.startSec,
        durationSec: slot.frames / FPS,
        frames: slot.frames,
        plan,
        alternatives: neighbour.alternatives,
        note: [rendered.note, `held over the next planned shot because ${why}`].filter(Boolean).join('; '),
      });
      console.log(`[ShotComposer] Beat ${beatIndex}: footage held over shot ${i} (${why}) instead of a ${gap.renderedType === 'color' ? 'plain background' : 'text card'}`);
      i = at;
    } catch (err) {
      console.warn(`[ShotComposer] Beat ${beatIndex}: couldn't hold footage over shot ${i}: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  }
  return out;
}

export interface ComposedBeat {
  trackPath: string;
  shots: ComposedShot[];
  leadInSec: number;
  tailSec: number;
}

/**
 * Extends a beat's timeline by its lead-in and tail: the first shot starts earlier and the last
 * runs on, while every cut stays on its word (now `leadInSec` into the track).
 */
export function padTimeline(slots: ShotSlot[], leadInSec: number, tailSec: number): ShotSlot[] {
  const leadFrames = Math.max(0, Math.round(leadInSec * FPS));
  const tailFrames = Math.max(0, Math.round(tailSec * FPS));
  const last = slots.length - 1;
  return slots.map((slot, i) => ({
    ...slot,
    startSec: i === 0 ? 0 : slot.startSec + leadFrames / FPS,
    frames: slot.frames + (i === 0 ? leadFrames : 0) + (i === last ? tailFrames : 0),
  }));
}

/**
 * Renders a beat as a sequence of shots cut on the narration, joined into one track exactly as
 * long as the narration. A shot that fails to render becomes a plain background so the beat's
 * timing (and every later cut) stays correct.
 */
export async function composeBeatTrack(options: ComposeBeatOptions): Promise<ComposedBeat> {
  const { beatIndex, shots, words, audioDurationSec, outputDir, renderShot, fallbackColor = '#0c0d10' } = options;
  const leadInSec = Math.round(Math.max(0, options.leadInSec ?? 0) * FPS) / FPS;
  const tailSec = Math.round(Math.max(0, options.tailSec ?? 0) * FPS) / FPS;
  const shotDir = path.join(outputDir, `beat_${beatIndex}_shots`);
  await fs.mkdir(shotDir, { recursive: true });

  const slots = padTimeline(computeShotTimeline(shots, words, audioDurationSec), leadInSec, tailSec);
  let rendered: ComposedBeat['shots'] = [];
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
  if (options.extendShot) rendered = await coverGaps(rendered, options.extendShot, shotDir, beatIndex);

  const trackPath = path.join(outputDir, `visuals_beat_${beatIndex}.mp4`);
  await concatClips(rendered.map((r) => r.clipPath), trackPath);
  await fs.writeFile(`${trackPath}.shots.json`, JSON.stringify({ beatIndex, leadInSec, tailSec, shots: rendered }, null, 2), 'utf-8');
  return { trackPath, shots: rendered, leadInSec, tailSec };
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
