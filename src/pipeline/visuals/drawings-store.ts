import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { drawingCode } from '@/lib/stickman/drawing-codes';

/**
 * The creator's drawings for a stickman video, filed by code in storage/drawings/<videoId>/
 * ("B05_S2.png"). This folder is the source of truth: a beat that renders again (a new plan,
 * a new look) picks its drawings up from here, and drawings can be uploaded before the visuals
 * stage has run.
 */

export const DRAWING_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

export const drawingsDir = (videoId: string) =>
  path.join(/* turbopackIgnore: true */ process.env.DRAWINGS_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'drawings'), videoId);

/** The drawing filed for a shot, or null. */
export async function findDrawing(videoId: string, beatIndex: number, shotIndex: number): Promise<string | null> {
  const code = drawingCode(beatIndex, shotIndex);
  for (const ext of DRAWING_EXTENSIONS) {
    const file = path.join(/* turbopackIgnore: true */ drawingsDir(videoId), `${code}${ext}`);
    if (await fs.stat(file).then((s) => s.isFile()).catch(() => false)) return file;
  }
  return null;
}

/** Files a drawing for a shot (replacing any earlier one, whatever its format). Returns its path. */
export async function saveDrawing(videoId: string, beatIndex: number, shotIndex: number, source: string): Promise<string> {
  const ext = path.extname(source).toLowerCase();
  if (!(DRAWING_EXTENSIONS as readonly string[]).includes(ext)) throw new Error(`Drawings must be PNG, JPG or WebP (got ${ext || 'no extension'})`);
  const dir = drawingsDir(videoId);
  await fs.mkdir(dir, { recursive: true });
  const code = drawingCode(beatIndex, shotIndex);
  await Promise.all(DRAWING_EXTENSIONS.map((e) => fs.rm(path.join(/* turbopackIgnore: true */ dir, `${code}${e}`), { force: true })));
  const target = path.join(/* turbopackIgnore: true */ dir, `${code}${ext === '.jpeg' ? '.jpg' : ext}`);
  await fs.copyFile(source, target);
  return target;
}

/** Codes of every drawing filed for the video ("B05_S2"). */
export async function listDrawings(videoId: string): Promise<Set<string>> {
  const files = await fs.readdir(drawingsDir(videoId)).catch(() => [] as string[]);
  return new Set(
    files
      .filter((f) => (DRAWING_EXTENSIONS as readonly string[]).includes(path.extname(f).toLowerCase()))
      .map((f) => path.basename(f, path.extname(f)).toUpperCase()),
  );
}
