import type { MediaCandidate } from './types';

/**
 * Your hunted moments and link clips as footage, for videos about a game: an explainer about GTA
 * can show real gameplay you already collected. Never offered for other videos (a GTA car chase
 * must not illustrate a documentary).
 */

/** A video counts as being about a game when its topic says so. */
export const GAME_TOPIC = /\b(gta|grand theft auto|gameplay|video ?games?|gaming|playstation|xbox|nintendo|minecraft|fortnite|call of duty|rockstar games)\b/i;

export const isGameTopic = (topic: string | null | undefined) => GAME_TOPIC.test(topic ?? '');

export interface MomentFootage {
  key: string;
  title: string;
  description: string;
  transcript: string;
  creator: string;
  pageUrl: string;
  file: string;
  thumb: string | null;
  durationSec: number;
}

const STOP = new Set(['the', 'and', 'with', 'from', 'that', 'this', 'into', 'over', 'they', 'their', 'what', 'when', 'gta', 'game', 'gameplay']);
const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)));

/** Moments whose words share something with the shot, best first, as footage candidates. */
export function searchMoments(query: string, moments: MomentFootage[], limit = 3): MediaCandidate[] {
  const want = words(query);
  if (!want.size) return [];
  return moments
    .map((m) => {
      const have = words(`${m.title} ${m.description} ${m.transcript.slice(0, 600)}`);
      return { m, shared: [...want].filter((w) => have.has(w)).length };
    })
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, limit)
    .map(({ m }) => ({
      id: `moment_${m.key}`,
      provider: 'uploaded' as const,
      mediaType: 'video' as const,
      title: `${m.title}. ${m.description}`.slice(0, 200),
      thumbnailUrl: m.thumb ?? '',
      downloadUrl: m.file,
      pageUrl: `moment:${m.key}`,
      duration: m.durationSec,
      license: 'creator_permission',
      attribution: `Gameplay: ${m.creator || 'a streamer'}${m.pageUrl ? ` (${m.pageUrl})` : ''}`,
    }));
}

const cache = globalThis as unknown as { __momentFootage?: { at: number; items: MomentFootage[] } };

/** Every cut moment and link clip, from the moments library (refreshed at most once a minute). */
export async function loadMomentFootage(): Promise<MomentFootage[]> {
  if (cache.__momentFootage && Date.now() - cache.__momentFootage.at < 60_000) return cache.__momentFootage.items;
  const { listLibrary } = await import('../compile/library');
  const items = (await listLibrary().catch(() => [])).map((l) => ({
    key: l.key,
    title: l.title,
    description: l.description,
    transcript: l.transcript,
    creator: l.creator,
    pageUrl: l.pageUrl,
    file: l.file,
    thumb: l.thumb,
    durationSec: Math.max(1, l.end - l.start),
  }));
  cache.__momentFootage = { at: Date.now(), items };
  return items;
}
