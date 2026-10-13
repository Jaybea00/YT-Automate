import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Pronunciation } from './speakable';

/** Channel-wide pronunciation list, kept with other local data under storage/. */
export function pronunciationsFile(): string {
  return path.join(process.cwd(), 'storage', 'settings', 'pronunciations.json');
}

export function sanitizePronunciations(value: unknown): Pronunciation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: Pronunciation[] = [];
  for (const item of value) {
    const term = typeof item?.term === 'string' ? item.term.trim().slice(0, 100) : '';
    const say = typeof item?.say === 'string' ? item.say.trim().slice(0, 200) : '';
    if (!term || !say || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push({ term, say });
  }
  return out;
}

export async function loadPronunciations(file = pronunciationsFile()): Promise<Pronunciation[]> {
  try {
    return sanitizePronunciations(JSON.parse(await fs.readFile(file, 'utf-8')));
  } catch {
    return [];
  }
}

export async function savePronunciations(list: unknown, file = pronunciationsFile()): Promise<Pronunciation[]> {
  const clean = sanitizePronunciations(list);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(clean, null, 2), 'utf-8');
  return clean;
}
