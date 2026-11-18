import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ClipProject } from './types';

/**
 * One folder per clip under storage/clipping/<id>: project.json plus the downloaded source,
 * stills, voice lines and the finished Short.
 */

export const clippingRoot = () => process.env.CLIPPING_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'clipping');

const ID_PATTERN = /^[a-z0-9-]{6,40}$/;
export const isClipId = (id: string) => ID_PATTERN.test(id);

export function clipDir(id: string): string {
  if (!isClipId(id)) throw new Error(`Invalid clip id "${id}"`);
  return path.join(clippingRoot(), id);
}

/** A file inside a clip's folder; refuses names that would step outside it. */
export function clipFile(id: string, name: string): string {
  const dir = clipDir(id);
  const full = path.resolve(dir, name);
  if (path.dirname(full) !== path.resolve(dir) && !full.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error(`Invalid file name "${name}"`);
  }
  return full;
}

export function newClipId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${day}-${randomBytes(4).toString('hex')}`;
}

export async function saveClip(project: ClipProject): Promise<ClipProject> {
  const dir = clipDir(project.id);
  await fs.mkdir(dir, { recursive: true });
  const next = { ...project, updatedAt: new Date().toISOString() };
  // Written to a temp file first so a reader never sees half a file
  const target = path.join(dir, 'project.json');
  const tmp = `${target}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
  await fs.rename(tmp, target);
  return next;
}

export async function loadClip(id: string): Promise<ClipProject | null> {
  if (!isClipId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(clipDir(id), 'project.json'), 'utf-8')) as ClipProject;
  } catch {
    return null;
  }
}

/** Applies a change to the saved project (read, change, write). */
export async function updateClip(id: string, change: (p: ClipProject) => ClipProject | void): Promise<ClipProject> {
  const current = await loadClip(id);
  if (!current) throw new Error(`Clip ${id} not found`);
  const draft = structuredClone(current);
  return saveClip(change(draft) ?? draft);
}

/** All clips, newest first. */
export async function listClips(): Promise<ClipProject[]> {
  const entries = await fs.readdir(clippingRoot(), { withFileTypes: true }).catch(() => []);
  const clips = await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => loadClip(e.name)));
  return clips.filter((c): c is ClipProject => c !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteClip(id: string): Promise<boolean> {
  if (!(await loadClip(id))) return false;
  await fs.rm(clipDir(id), { recursive: true, force: true });
  return true;
}
