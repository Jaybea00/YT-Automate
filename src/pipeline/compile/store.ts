import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileAtomic } from '../utils/atomic-write';
import type { Compilation } from './types';

/** One folder per compilation under storage/compilations/<id>. */

export const compilationsRoot = () => process.env.COMPILATIONS_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'compilations');

const ID_PATTERN = /^[a-z0-9-]{6,40}$/;
export const isCompilationId = (id: string) => ID_PATTERN.test(id);

export function compilationDir(id: string): string {
  if (!isCompilationId(id)) throw new Error(`Invalid compilation id "${id}"`);
  return path.join(compilationsRoot(), id);
}

export function compilationFile(id: string, name: string): string {
  const dir = path.resolve(compilationDir(id));
  const full = path.resolve(dir, name);
  if (!full.startsWith(dir + path.sep)) throw new Error(`Invalid file name "${name}"`);
  return full;
}

export function newCompilationId(now = new Date()): string {
  return `${now.toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(4).toString('hex')}`;
}

export async function saveCompilation(c: Compilation): Promise<Compilation> {
  await fs.mkdir(compilationDir(c.id), { recursive: true });
  const next = { ...c, updatedAt: new Date().toISOString() };
  await writeFileAtomic(path.join(compilationDir(c.id), 'compilation.json'), JSON.stringify(next, null, 2));
  return next;
}

export async function loadCompilation(id: string): Promise<Compilation | null> {
  if (!isCompilationId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(compilationDir(id), 'compilation.json'), 'utf-8')) as Compilation;
  } catch {
    return null;
  }
}

const locks = globalThis as unknown as { __compLocks?: Map<string, Promise<unknown>> };
/** Read, change, write; changes to one compilation are applied one at a time. */
export async function updateCompilation(id: string, change: (c: Compilation) => Compilation | void): Promise<Compilation> {
  locks.__compLocks ??= new Map();
  const next = (locks.__compLocks.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const current = await loadCompilation(id);
      if (!current) throw new Error(`Compilation ${id} not found`);
      const draft = structuredClone(current);
      return saveCompilation(change(draft) ?? draft);
    });
  locks.__compLocks.set(id, next);
  return next;
}

export async function listCompilations(): Promise<Compilation[]> {
  const entries = await fs.readdir(compilationsRoot(), { withFileTypes: true }).catch(() => []);
  const all = await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => loadCompilation(e.name)));
  return all.filter((c): c is Compilation => c !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteCompilation(id: string): Promise<boolean> {
  if (!(await loadCompilation(id))) return false;
  await fs.rm(compilationDir(id), { recursive: true, force: true });
  return true;
}
