import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashtag } from '../clipping/package';
import type { Compilation } from './types';

/** Every streamer credited with a link to their moment; in long form, in countdown order. */
export function creditsBlock(c: Compilation): string {
  const n = c.items.length;
  return c.items
    .map((it, i) => `${c.format === 'long' ? `#${n - i} ` : '• '}${it.label || it.title} by ${it.creator || 'unknown'}${it.pageUrl ? `: ${it.pageUrl}` : ''}`)
    .join('\n');
}

export function composeCompilationDescription(c: Compilation): string {
  const tags = [c.format === 'short' ? '#Shorts' : '', '#GTA6', ...c.tags.slice(0, 3).map(hashtag)].filter((t, i, all) => t && all.indexOf(t) === i);
  return [c.description.trim(), `Clips featured:\n${creditsBlock(c)}`, tags.join(' ')].filter(Boolean).join('\n\n');
}

export function compilationUploadText(c: Compilation): string {
  return [
    'TITLE OPTIONS',
    ...c.titles.map((t, i) => `${i + 1}. ${t}`),
    '',
    'DESCRIPTION',
    composeCompilationDescription(c),
    '',
    'TAGS (paste into the tags box)',
    c.tags.join(', '),
    '',
  ].join('\n');
}

export async function writeCompilationUploadInfo(dir: string, c: Compilation): Promise<void> {
  await fs.mkdir(path.join(dir, 'export'), { recursive: true });
  await fs.writeFile(path.join(dir, 'export', 'upload-info.txt'), compilationUploadText(c), 'utf-8');
}
