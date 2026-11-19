import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { clipDir, listClips } from '../clipping/store';
import { timestampUrl } from '../hunter/run';
import { huntDir, listHunts } from '../hunter/store';
import { listCompilations } from './store';
import type { LibraryItem } from './types';

const exists = (file: string) => fs.stat(file).then((s) => s.isFile() && s.size > 0).catch(() => false);

/**
 * Everything that can go into a compilation: every cut moment from every hunt (not hidden), and
 * every clip made from a link (its source file, trimmed as the clip editor trimmed it). Newest first.
 */
export async function listLibrary(): Promise<LibraryItem[]> {
  const [hunts, clips, compilations] = await Promise.all([listHunts(), listClips(), listCompilations()]);
  const usedIn = new Map<string, string[]>();
  for (const c of compilations) for (const item of c.items) usedIn.set(item.key, [...(usedIn.get(item.key) ?? []), c.id]);

  const items: LibraryItem[] = [];
  for (const h of hunts) {
    for (const m of h.moments) {
      if (m.discarded || m.status !== 'cut' || !m.file) continue;
      const file = path.join(huntDir(h.id), m.file);
      if (!(await exists(file))) continue;
      const key = `hunt:${h.id}:${m.id}`;
      items.push({
        key,
        kind: 'moment',
        title: m.hook || m.reason.slice(0, 80),
        description: m.reason,
        recipe: m.recipe,
        score: m.score,
        creator: h.creator || h.uploaderHandle || h.uploader,
        platform: h.platform,
        pageUrl: timestampUrl(h.pageUrl, h.platform, m.start),
        file,
        start: 0,
        end: Math.round((m.end - m.start) * 10) / 10,
        thumb: m.thumb ? path.join(huntDir(h.id), m.thumb) : null,
        transcript: m.transcript,
        createdAt: h.createdAt,
        usedIn: usedIn.get(key) ?? [],
      });
    }
  }

  // The same post made into a clip more than once is listed once (the newest; clips come newest first)
  const seenPosts = new Set<string>();
  for (const c of clips) {
    // Hunted moments sent to the clip editor are already listed as moments
    if (!c.source?.file || !c.analysis || hunts.some((h) => h.moments.some((m) => m.clipId === c.id))) continue;
    const post = (c.source.pageUrl || c.sourceUrl).replace(/[?#].*$/, '').toLowerCase();
    if (seenPosts.has(post)) continue;
    seenPosts.add(post);
    const file = path.join(clipDir(c.id), c.source.file);
    if (!(await exists(file))) continue;
    const key = `clip:${c.id}`;
    const thumb = c.output?.thumbnail ? path.join(clipDir(c.id), c.output.thumbnail) : c.analysis.frames[0] ? path.join(clipDir(c.id), c.analysis.frames[0].file) : null;
    items.push({
      key,
      kind: 'clip',
      title: c.plan?.titles[0] || c.source.title || c.sourceUrl,
      description: c.note || c.plan?.description || c.source.postText.slice(0, 200),
      recipe: 'other',
      score: null,
      creator: c.creator || c.source.uploaderHandle || c.source.uploader,
      platform: c.source.platform,
      pageUrl: c.source.pageUrl,
      file,
      start: c.plan?.trimStart ?? 0,
      end: c.plan?.trimEnd ?? c.analysis.durationSec,
      thumb,
      transcript: c.analysis.transcript,
      createdAt: c.createdAt,
      usedIn: usedIn.get(key) ?? [],
    });
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
