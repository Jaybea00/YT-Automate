import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DrawingMood, ShotPlan } from '@/lib/script/generate-script';
import { DEFAULT_TRANSLATION, fetchVerses } from '@/lib/stickman/bible';
import { ENCODE, STILL_MOTIONS, drawingFit, drawingPageColour, makeDrawingClip, type StillMotion } from './clips';
import { drawingFocus, locateNoteTarget, type FocusBox } from './drawing-focus';
import { renderNoteLayer, type NoteLayerSpec, type PageBox } from './drawing-notes-layer';
import { renderTextCard } from './motion-shots';
import { FPS, renderMotionClip } from './motion/frame-renderer';
import { drawingRevealTemplate, verseTemplate } from './motion/stickman-templates';
import { getFfmpegPath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);
import type { RenderedShot, ShotSlot } from './shot-composer';
import type { ShotRenderContext, TypedShotRenderer } from './shot-renderers';

/**
 * Stickman shots. A drawing shot shows the creator's uploaded drawing, moved to suit its mood;
 * until the drawing arrives, its narration shows as doodle type and the shot is marked as still
 * needing a drawing. A verse shot shows the World English Bible's words for its reference.
 */

/** How a drawing moves for its mood; moods without one rotate through the gentle camera moves. */
export const MOOD_MOTION: Partial<Record<DrawingMood, StillMotion>> = {
  happy: 'bounce',
  funny: 'bounce',
  surprised: 'pop',
  scared: 'shake',
  angry: 'shake',
  sad: 'zoom_out',
  tense: 'zoom_in',
};

export function motionForDrawing(shot: ShotPlan, counter: { next: number }): StillMotion {
  const byMood = shot.drawing ? MOOD_MOTION[shot.drawing.mood] : undefined;
  if (byMood) return byMood;
  return STILL_MOTIONS[counter.next++ % STILL_MOTIONS.length];
}

/**
 * A drawing shot: the creator's filed drawing when there is one; before it arrives, the narration as
 * doodle type, marked as waiting.
 */
export const renderDrawing: TypedShotRenderer = async (shot, slot, clipPath, ctx) => {
  const file = slot.index !== undefined ? await ctx.drawingFile?.(ctx.beatIndex, slot.index) : null;
  if (file) return renderDrawingFile(shot, slot, clipPath, ctx, { path: file });
  const card = await renderTextCard(shot, slot, clipPath, ctx, 'drawing needed');
  return { ...card, drawingNeeded: true };
};

/** How long a draw-on reveal takes. */
export const REVEAL_FRAMES = Math.round(0.8 * FPS);
/** Reveals stay special: at least this many drawings apart. */
const MIN_DRAWINGS_BETWEEN_REVEALS = 3;
/** A shot shorter than this has no time for a reveal and a camera move. */
const MIN_REVEAL_SHOT_FRAMES = Math.round(2.2 * FPS);

/**
 * The drawings that are drawn on ("beat:shot" keys): the video's first drawing, and scene-setting
 * (wide) drawings at least a few drawings after the last one. Worked out from the whole plan, so
 * the visuals stage and a single re-rendered shot always agree.
 */
export function revealShots(beats: Array<{ index: number; shots?: ShotPlan[] }>): Set<string> {
  const out = new Set<string>();
  let since = Number.POSITIVE_INFINITY;
  for (const beat of beats) {
    (beat.shots ?? []).forEach((shot, i) => {
      if (shot.visual_type !== 'drawing') return;
      if (since === Number.POSITIVE_INFINITY || (shot.drawing?.framing === 'wide' && since >= MIN_DRAWINGS_BETWEEN_REVEALS)) {
        out.add(`${beat.index}:${i}`);
        since = 0;
      } else {
        since++;
      }
    });
  }
  return out;
}

function shouldReveal(ctx: ShotRenderContext, slot: ShotSlot): boolean {
  return slot.index !== undefined && slot.frames >= MIN_REVEAL_SHOT_FRAMES && Boolean(ctx.reveal?.has(`${ctx.beatIndex}:${slot.index}`));
}

/**
 * A creator's drawing as the shot, on the style's paper. The camera centres on the drawing's
 * subject (found once by the vision model), moves for the drawing's mood, and on a long shot cuts
 * to a close-up of the subject. Scene-setting drawings are drawn on first (shouldReveal).
 */
export async function renderDrawingFile(
  shot: ShotPlan,
  slot: ShotSlot,
  clipPath: string,
  ctx: ShotRenderContext,
  file: { path: string; license?: string | null; attribution?: string | null },
): Promise<RenderedShot> {
  const focus = await drawingFocus(file.path, shot, ctx.llmProvider, ctx.llmCtx);
  const reveal = shouldReveal(ctx, slot);
  const note = await noteLayerFor(shot, file.path, clipPath, ctx);
  // A reveal ends on the drawing at rest, so the camera after it starts there: a push-in
  const motion = reveal ? 'zoom_in' : motionForDrawing(shot, ctx.motionCounter);
  let closeUp = false;
  if (reveal) {
    const revealPath = clipPath.replace(/\.mp4$/, '.reveal.mp4');
    const restPath = clipPath.replace(/\.mp4$/, '.rest.mp4');
    try {
      const page = await drawingPageColour(file.path, ctx.theme.background);
      const data = (await fs.readFile(/* turbopackIgnore: true */ file.path)).toString('base64');
      const mime = /\.png$/i.test(file.path) ? 'image/png' : /\.webp$/i.test(file.path) ? 'image/webp' : 'image/jpeg';
      await renderMotionClip({
        html: drawingRevealTemplate({
          imageUrl: `data:${mime};base64,${data}`,
          page,
          focusX: focus ? (focus[1] + focus[3]) / 2 : 0.5,
          focusY: focus ? (focus[0] + focus[2]) / 2 : 0.5,
        }),
        durationSec: REVEAL_FRAMES / FPS,
        outputPath: revealPath,
        browser: ctx.browser,
      });
      // The label or bubble comes in right after the drawing has drawn on
      ({ closeUp } = await makeDrawingClip(file.path, slot.frames - REVEAL_FRAMES, restPath, motion, ctx.theme.background, { focus, layer: note?.path, layerAt: 0.15 }));
      await joinClips([revealPath, restPath], slot.frames, clipPath);
    } finally {
      await Promise.all([revealPath, restPath, note?.path].map((p) => p && fs.rm(p, { force: true }).catch(() => {})));
    }
  } else {
    try {
      ({ closeUp } = await makeDrawingClip(file.path, slot.frames, clipPath, motion, ctx.theme.background, { focus, layer: note?.path }));
    } finally {
      if (note) await fs.rm(note.path, { force: true }).catch(() => {});
    }
  }
  return {
    clipPath,
    renderedType: 'drawing',
    still: true,
    license: file.license ?? 'own_work',
    licenseSource: 'uploaded',
    attribution: file.attribution ?? null,
    note: `drawing (${motion})${reveal ? ' drawn on' : ''}${closeUp ? ' + close-up' : ''}${note?.label ? ' + label' : ''}${note?.bubble ? ' + bubble' : ''}${focus ? '' : ' (centre)'}`,
  };
}

/**
 * The shot's label and speech bubble as a transparent layer in page coordinates, with each placed
 * by what the vision model finds in the drawing; one it can't find is left out rather than
 * pointing at the wrong thing. Null when there's nothing to draw.
 */
async function noteLayerFor(
  shot: ShotPlan,
  file: string,
  clipPath: string,
  ctx: ShotRenderContext,
): Promise<{ path: string; label: boolean; bubble: boolean } | null> {
  const { label, bubble } = shot.drawing ?? {};
  if (!label && !bubble) return null;
  const fit = await drawingFit(file);
  if (!fit) return null;
  const toPage = (b: FocusBox): PageBox => [
    fit.offsetY + b[0] * fit.srcHeight * fit.scale,
    fit.offsetX + b[1] * fit.srcWidth * fit.scale,
    fit.offsetY + b[2] * fit.srcHeight * fit.scale,
    fit.offsetX + b[3] * fit.srcWidth * fit.scale,
  ];
  const [labelBox, speakerBox] = await Promise.all([
    label ? locateNoteTarget(file, 'label', label.target, ctx.llmProvider, ctx.llmCtx, label.text) : null,
    bubble ? locateNoteTarget(file, 'bubble', bubble.speaker, ctx.llmProvider, ctx.llmCtx) : null,
  ]);
  const spec: NoteLayerSpec = {
    ...(label && labelBox ? { label: { text: label.text, target: toPage(labelBox) } } : {}),
    ...(bubble && speakerBox ? { bubble: { text: bubble.text, speaker: toPage(speakerBox) } } : {}),
  };
  if (!spec.label && !spec.bubble) return null;
  try {
    const out = await renderNoteLayer(spec, ctx.theme, clipPath.replace(/\.mp4$/, '.note.png'), ctx.browser);
    return { path: out, label: Boolean(spec.label), bubble: Boolean(spec.bubble) };
  } catch (err) {
    console.warn(`[DrawingShot] Beat ${ctx.beatIndex}: label/bubble layer failed (${err instanceof Error ? err.message.slice(0, 120) : err}); drawing without it`);
    return null;
  }
}

/** Joins silent clips end to end into an exact frame count (same encoding as every shot). */
async function joinClips(parts: string[], frames: number, outputPath: string): Promise<void> {
  const inputs = parts.flatMap((p) => ['-i', p]);
  const normalised = parts.map((_, i) => `[${i}:v]fps=${FPS},format=yuv420p,setsar=1[p${i}]`).join(';');
  const filter = `${normalised};${parts.map((_, i) => `[p${i}]`).join('')}concat=n=${parts.length}:v=1:a=0[v]`;
  await execFileAsync(getFfmpegPath(), ['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-frames:v', String(frames), ...ENCODE, outputPath]);
}

/** The verse's own words (World English Bible); without them the shot falls back like any graphic. */
export const renderVerse: TypedShotRenderer = async (shot, slot, clipPath, ctx) => {
  if (!shot.verse) throw new Error('verse shot has no reference');
  const passage = await fetchVerses(shot.verse.reference, ctx.bibleTranslation ?? DEFAULT_TRANSLATION);
  if (!passage) throw new Error(`Could not fetch ${shot.verse.reference} from the World English Bible`);
  await renderMotionClip({
    html: verseTemplate(ctx.theme, { reference: passage.reference, text: passage.text, translation: 'World English Bible' }),
    durationSec: slot.frames / FPS,
    outputPath: clipPath,
    browser: ctx.browser,
  });
  return { clipPath, renderedType: 'verse', license: 'public_domain', licenseSource: 'generated', note: `World English Bible, ${passage.reference}` };
};
