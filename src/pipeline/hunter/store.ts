import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileAtomic } from '../utils/atomic-write';
import type { Hunt } from './types';

/** One folder per hunt under storage/hunts/<id>: hunt.json, the stream's audio and chat, and the cut moments. */

export const huntsRoot = () => process.env.HUNTS_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'hunts');

const ID_PATTERN = /^[a-z0-9-]{6,40}$/;
export const isHuntId = (id: string) => ID_PATTERN.test(id);

export function huntDir(id: string): string {
  if (!isHuntId(id)) throw new Error(`Invalid hunt id "${id}"`);
  return path.join(huntsRoot(), id);
}

/** A file inside a hunt's folder; refuses names that would step outside it. */
export function huntFile(id: string, name: string): string {
  const dir = path.resolve(huntDir(id));
  const full = path.resolve(dir, name);
  if (!full.startsWith(dir + path.sep)) throw new Error(`Invalid file name "${name}"`);
  return full;
}

export function newHuntId(now = new Date()): string {
  return `${now.toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(4).toString('hex')}`;
}

export async function saveHunt(hunt: Hunt): Promise<Hunt> {
  const dir = huntDir(hunt.id);
  await fs.mkdir(dir, { recursive: true });
  const next = { ...hunt, updatedAt: new Date().toISOString() };
  await writeFileAtomic(path.join(dir, 'hunt.json'), JSON.stringify(next, null, 2));
  return next;
}

export async function loadHunt(id: string): Promise<Hunt | null> {
  if (!isHuntId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(huntDir(id), 'hunt.json'), 'utf-8')) as Hunt;
  } catch {
    return null;
  }
}

/** Read, change, write. Changes to one hunt are applied one at a time so none is lost. */
const locks = globalThis as unknown as { __huntLocks?: Map<string, Promise<unknown>> };
export async function updateHunt(id: string, change: (h: Hunt) => Hunt | void): Promise<Hunt> {
  locks.__huntLocks ??= new Map();
  const previous = locks.__huntLocks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const current = await loadHunt(id);
    if (!current) throw new Error(`Hunt ${id} not found`);
    const draft = structuredClone(current);
    return saveHunt(change(draft) ?? draft);
  });
  locks.__huntLocks.set(id, next);
  return next;
}

export async function listHunts(): Promise<Hunt[]> {
  const entries = await fs.readdir(huntsRoot(), { withFileTypes: true }).catch(() => []);
  const hunts = await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => loadHunt(e.name)));
  return hunts.filter((h): h is Hunt => h !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteHunt(id: string): Promise<boolean> {
  if (!(await loadHunt(id))) return false;
  await fs.rm(huntDir(id), { recursive: true, force: true });
  return true;
}
