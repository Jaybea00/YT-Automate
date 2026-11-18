import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ShotPlan } from '@/lib/script/generate-script';
import type { LLMProvider, ProviderCallContext } from '../providers/types';
import { getFfmpegPath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);

/**
 * Where the camera should look in a stickman drawing: the vision model finds the main character
 * (or the object the scene is about), once per drawing; the answer is cached beside the file and
 * redone only when the drawing changes. Camera moves push in on it, and long shots cut to a
 * close-up of it.
 */

/** [ymin, xmin, ymax, xmax], 0-1 of the drawing. */
export type FocusBox = [number, number, number, number];

const FocusSchema = z.object({
  found: z.boolean(),
  box: z.array(z.number()).length(4),
});

const VISION_WIDTH = 1024;

const cachePath = (file: string) => `${file}.focus.json`;

async function fileKey(file: string): Promise<string | null> {
  const st = await fs.stat(file).catch(() => null);
  return st ? `${Math.round(st.mtimeMs)}-${st.size}` : null;
}

/**
 * What to look for, described by the scene (characters aren't labelled in drawings, so asking for
 * one by name finds nothing).
 */
export function focusTarget(shot: ShotPlan): string {
  const scene = shot.drawing?.scene ?? shot.covers;
  const who = shot.drawing?.characters?.find((c) => c.trim());
  return who
    ? `the figure the scene is about (called "${who}" in the story; names are not written in the drawing). The scene: ${scene}`
    : `the figure or object this scene is about. The scene: ${scene}`;
}

/** A usable box: inside the frame, not a sliver, not the whole picture. */
export function usableFocus(box: number[]): box is FocusBox {
  if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) return false;
  const [y0, x0, y1, x1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  return x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1 && w > 0.04 && h > 0.04 && w * h < 0.85;
}

/**
 * The focus box of a drawing (0-1), or null when it can't be found (no vision model, the call
 * failed, nothing clear): the camera then moves around the centre as before.
 */
export async function drawingFocus(file: string, shot: ShotPlan, llm?: LLMProvider, ctx?: ProviderCallContext): Promise<FocusBox | null> {
  return locateInDrawing(
    file,
    'focus',
    `The camera will push in on what matters.
Find: ${focusTarget(shot)}.
The drawing may not match the description exactly; pick the most prominent figure or object that fits it best (if two figures act together, box them both).
- found: false only if the drawing is empty or has no figure or object at all.`,
    llm,
    ctx,
  );
}

/**
 * Where a label's arrow should point, or a speech bubble's speaker is: null when it isn't clearly
 * in the drawing (the label or bubble is then left out rather than pointing at the wrong thing).
 */
export async function locateNoteTarget(
  file: string,
  kind: 'label' | 'bubble',
  what: string,
  llm?: LLMProvider,
  ctx?: ProviderCallContext,
  labelText?: string,
): Promise<FocusBox | null> {
  // The description was written before the drawing existed: pose, setting and small details may
  // differ, so the match is on what it is, not how it was imagined
  const loose = 'The description was written before the drawing was made, so details like pose, position or props may differ; match on what it is.';
  return locateInDrawing(
    file,
    `${kind}:${(labelText ? `${labelText}|` : '')}${what}`.toLowerCase().slice(0, 160),
    kind === 'label'
      ? `A label${labelText ? ` reading "${labelText}"` : ''} with an arrow will point at: ${what}. ${loose}
- found: true if it, or the figure or object clearly meant to be it, is in the drawing; false if nothing like it is there.`
      : `A speech bubble will come from: ${what}. ${loose}
- found: true if a figure that is clearly meant to be that speaker is in the drawing; box the whole figure (the bubble goes by its head).`,
    llm,
    ctx,
  );
}

/**
 * One vision question about a drawing, its answer cached beside the file under `tag` and asked
 * again only when the drawing changes.
 */
async function locateInDrawing(file: string, tag: string, ask: string, llm?: LLMProvider, ctx?: ProviderCallContext): Promise<FocusBox | null> {
  const key = await fileKey(file);
  if (!key) return null;
  const cached = await fs
    .readFile(cachePath(file), 'utf-8')
    .then((s) => JSON.parse(s) as { key: string; boxes?: Record<string, FocusBox | null> })
    .catch(() => null);
  const boxes = cached?.key === key ? (cached.boxes ?? {}) : {};
  if (tag in boxes) return boxes[tag];
  if (!llm?.supportsVision || !ctx) return null;

  const jpeg = `${file}.locate.jpg`;
  try {
    // Flattened onto white (transparent drawings) and shrunk for the vision call
    await execFileAsync(getFfmpegPath(), [
      '-v', 'error', '-y', '-i', file,
      '-filter_complex', `[0:v]scale=${VISION_WIDTH}:-2,format=rgba,split[a][b];[a]drawbox=c=white:t=fill[bg];[bg][b]overlay,format=yuvj420p[v]`,
      '-map', '[v]', '-frames:v', '1', jpeg,
    ]);
    const data = (await fs.readFile(/* turbopackIgnore: true */ jpeg)).toString('base64');
    const { data: answer } = await llm.generateJson(
      {
        prompt: `This is a cartoon drawing (stick figures or illustrated characters) for a video. ${ask}
- box: [ymin, xmin, ymax, xmax] scaled 0-1000, tight around it (for a figure, the whole figure). [0,0,0,0] if not found.`,
        schema: FocusSchema,
        images: [{ mimeType: 'image/jpeg', data }],
        maxTokens: 300,
      },
      ctx,
    );
    const box = answer.found ? (answer.box.map((v) => v / 1000) as number[]) : [];
    const found = usableFocus(box) ? box : null;
    await fs.writeFile(cachePath(file), JSON.stringify({ key, boxes: { ...boxes, [tag]: found } }), 'utf-8').catch(() => {});
    return found;
  } catch (err) {
    console.warn(`[DrawingFocus] Could not locate ${tag} (${err instanceof Error ? err.message.slice(0, 120) : err})`);
    return null;
  } finally {
    await fs.rm(jpeg, { force: true }).catch(() => {});
  }
}
