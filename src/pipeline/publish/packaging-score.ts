import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { LLMProvider, LlmImage, ProviderCallContext } from '../providers/types';
import { getFfmpegPath } from '../utils/ffmpeg';
import { isoSeconds, takeSearch } from '../visuals/youtube-cc';

const execFileAsync = promisify(execFile);

/**
 * Title and thumbnail pairs, scored: every title option against every thumbnail, judged by the
 * LLM the way a viewer meets them, small, in a feed of the niche's most-watched videos on the
 * same topic. It says which pairs to put up first in YouTube's "Test & compare" and what would
 * lift the weakest. The niche's videos come from YouTube's search (one search from the shared
 * daily allowance); without a YouTube key, or with the allowance used up, the pairs are scored
 * on their own.
 */

const API = 'https://www.googleapis.com/youtube/v3';
/** Long videos only: Shorts compete in a different feed. */
const MIN_COMPETITOR_SEC = 180;
export const MAX_COMPETITORS = 8;
export const MAX_TITLES = 5;

export interface NicheVideo {
  id: string;
  title: string;
  channel: string;
  views: number;
  thumbUrl: string;
}

export interface PairScore {
  /** Index into the scored titles. */
  title: number;
  /** The thumbnail's number (1-based, as on the publish page). */
  thumbnail: number;
  /** 1-10: how likely a viewer in this feed is to click. */
  score: number;
  reason: string;
}

export interface PackagingScore {
  scoredAt: string;
  query: string;
  competitors: NicheVideo[];
  /** The titles and thumbnail texts as scored (the scores go stale when either changes). */
  titles: string[];
  thumbnailTexts: string[];
  pairs: PairScore[];
  /** The pairs to test first, best first: different thumbnails where possible. */
  best: Array<{ title: number; thumbnail: number }>;
  /** What the niche's top videos have in common, in a sentence or two. */
  niche: string;
  /** Concrete changes that would lift the weaker pairs. */
  advice: string[];
}

interface SearchItem {
  id: { videoId: string };
}
interface VideoItem {
  id: string;
  snippet: { title: string; channelTitle: string; thumbnails?: Record<string, { url: string }> };
  statistics?: { viewCount?: string };
  contentDetails?: { duration?: string };
}

/**
 * What to search YouTube for: the topic without framing like "POV:" (searches for it return
 * mostly Shorts), then the title when it says something different. At most two searches.
 */
export function nicheQueries(topic: string, title: string): string[] {
  const clean = (s: string) => s.replace(/^\s*(pov|story ?time|explained|essay)\s*:\s*/i, '').replace(/["“”]/g, '').trim();
  const out: string[] = [];
  for (const q of [clean(topic), clean(title)]) if (q && !out.some((o) => o.toLowerCase() === q.toLowerCase())) out.push(q);
  return out.slice(0, 2);
}

/**
 * The most-watched long videos on the topic, from YouTube (empty without a key or allowance).
 * Regular-length videos only (4-20 minutes), so Shorts don't crowd them out; the results of each
 * query are merged in search order.
 */
export async function nicheVideos(queries: string | string[], options: { apiKey?: string; fetcher?: typeof fetch } = {}): Promise<NicheVideo[]> {
  const apiKey = options.apiKey ?? process.env.YOUTUBE_API_KEY;
  const fetcher = options.fetcher ?? fetch;
  const list = (Array.isArray(queries) ? queries : [queries]).map((q) => q.trim()).filter(Boolean);
  if (!apiKey || !list.length) return [];
  const ids: string[] = [];
  for (const q of list) {
    if (!(await takeSearch())) break;
    const search = new URL(`${API}/search`);
    Object.entries({ part: 'id', q, type: 'video', videoDuration: 'medium', order: 'relevance', relevanceLanguage: 'en', safeSearch: 'moderate', maxResults: '12', key: apiKey }).forEach(
      ([k, v]) => search.searchParams.set(k, v),
    );
    const sres = await fetcher(search, { signal: AbortSignal.timeout(20_000) });
    if (!sres.ok) throw new Error(`YouTube search failed (${sres.status})`);
    for (const i of ((await sres.json()) as { items?: SearchItem[] }).items ?? []) if (i.id.videoId && !ids.includes(i.id.videoId)) ids.push(i.id.videoId);
  }
  if (!ids.length) return [];
  const details = new URL(`${API}/videos`);
  Object.entries({ part: 'snippet,statistics,contentDetails', id: ids.slice(0, 50).join(','), key: apiKey }).forEach(([k, v]) => details.searchParams.set(k, v));
  const dres = await fetcher(details, { signal: AbortSignal.timeout(20_000) });
  if (!dres.ok) throw new Error(`YouTube video details failed (${dres.status})`);
  return pickCompetitors(((await dres.json()) as { items?: VideoItem[] }).items ?? []);
}

/** Long videos only, most-watched first. */
export function pickCompetitors(items: VideoItem[]): NicheVideo[] {
  return items
    .filter((v) => isoSeconds(v.contentDetails?.duration ?? '') >= MIN_COMPETITOR_SEC)
    .map((v) => ({
      id: v.id,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      views: Number(v.statistics?.viewCount ?? 0),
      // 320x180: the size thumbnails are judged at in a feed
      thumbUrl: v.snippet.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, MAX_COMPETITORS);
}

const views = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

export function buildScorePrompt(input: { topic: string; summary: string; titles: string[]; thumbnailTexts: string[]; competitors: NicheVideo[] }): string {
  const { titles, thumbnailTexts, competitors } = input;
  const c = competitors.length;
  const feed = c
    ? `Images 1-${c} are the thumbnails of the most-watched videos YouTube found for this topic, as a viewer sees them in a feed (a search can bring in an off-topic video: list those under off_topic and leave them out of your judgement):\n${competitors.map((v, i) => `${i + 1}. "${v.title}" (${v.channel}, ${views(v.views)} views)`).join('\n')}\n\n`
    : 'No feed of competing videos is available: judge the pairs on their own.\n\n';
  const ours = thumbnailTexts.map((t, i) => `Thumbnail ${i + 1} = image ${c + i + 1} (its text: "${t}")`).join('\n');
  return `You are a YouTube packaging strategist. A new video on "${input.topic}" needs its title and thumbnail chosen.
What the video is about: ${input.summary}

${feed}Our thumbnails, at the same small size:
${ours}

Our title options:
${titles.map((t, i) => `Title ${i + 1}: "${t}"`).join('\n')}

Score every pair (each title with each thumbnail, ${titles.length * thumbnailTexts.length} pairs) from 1 to 10: how likely a viewer scrolling ${c ? 'this feed' : 'a feed on this topic'} is to click it. Judge:
- whether the thumbnail stands out next to the others (colour, contrast, one clear subject, a face or emotion) and reads at this small size;
- whether title and thumbnail work as a pair: they complement each other and open one clear question, never repeat the same words;
- whether the promise is clear and specific, and honest to what the video is about.
Use the whole scale: a 9 or 10 only for a pair that would clearly beat the feed. Give each pair one short reason that names what helps or hurts it.
${
    c
      ? "Then say in a sentence or two what the on-topic videos' thumbnails and titles have in common (their pattern)"
      : 'Leave niche empty (there is no feed to describe)'
  }, and give up to three concrete changes that would lift our weaker pairs (a sharper word, bigger text, a different frame).`;
}

const ScoreSchema = z.object({
  pairs: z.array(z.object({ title: z.number(), thumbnail: z.number(), score: z.number(), reason: z.string() })),
  niche: z.string(),
  /** Feed images (1-based) that are off-topic. */
  off_topic: z.array(z.number()).optional(),
  advice: z.array(z.string()),
});
export type ScoreResult = z.infer<typeof ScoreSchema>;

/**
 * The model's scores kept to the real pairs (1-based in its answer, title stored 0-based), one
 * per pair, 1-10; a pair it skipped is left out rather than guessed.
 */
export function normalizePairs(raw: ScoreResult['pairs'], titleCount: number, thumbCount: number): PairScore[] {
  const seen = new Set<string>();
  const out: PairScore[] = [];
  for (const p of raw) {
    const title = Math.round(p.title) - 1;
    const thumbnail = Math.round(p.thumbnail);
    if (title < 0 || title >= titleCount || thumbnail < 1 || thumbnail > thumbCount) continue;
    const key = `${title}:${thumbnail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, thumbnail, score: Math.max(1, Math.min(10, Math.round(p.score * 10) / 10)), reason: p.reason.trim().slice(0, 300) });
  }
  return out.sort((a, b) => b.score - a.score || a.title - b.title || a.thumbnail - b.thumbnail);
}

/**
 * Pairs to test first: the best pair, then the best with a thumbnail not yet chosen, and so on
 * (YouTube tests thumbnails against each other), up to three.
 */
export function bestPairs(pairs: PairScore[], max = 3): Array<{ title: number; thumbnail: number }> {
  const picked: PairScore[] = [];
  for (const p of pairs) {
    if (picked.length >= max) break;
    if (picked.some((q) => q.thumbnail === p.thumbnail)) continue;
    picked.push(p);
  }
  // Fewer thumbnails than slots: fill with the next best pairs
  for (const p of pairs) {
    if (picked.length >= max) break;
    if (!picked.includes(p)) picked.push(p);
  }
  return picked.map(({ title, thumbnail }) => ({ title, thumbnail }));
}

/** An image as the model sees it in a feed: 320x180 JPEG. */
async function feedSized(file: string): Promise<LlmImage> {
  const { stdout } = await execFileAsync(getFfmpegPath(), ['-v', 'error', '-i', file, '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2', '-frames:v', '1', '-f', 'mjpeg', '-q:v', '4', '-'], {
    encoding: 'buffer',
    maxBuffer: 4 << 20,
  });
  return { mimeType: 'image/jpeg', data: (stdout as unknown as Buffer).toString('base64') };
}

async function fetchImage(url: string, fetcher: typeof fetch): Promise<LlmImage | null> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return null;
  return { mimeType: res.headers.get('content-type')?.split(';')[0] || 'image/jpeg', data: Buffer.from(await res.arrayBuffer()).toString('base64') };
}

export async function scorePackaging(input: {
  topic: string;
  summary: string;
  titles: string[];
  thumbnails: Array<{ text: string; path: string }>;
  llm: LLMProvider;
  ctx: ProviderCallContext;
  fetcher?: typeof fetch;
  now?: Date;
}): Promise<PackagingScore> {
  const fetcher = input.fetcher ?? fetch;
  const titles = [...new Set(input.titles.map((t) => t.trim()).filter(Boolean))].slice(0, MAX_TITLES);
  if (!titles.length) throw new Error('Write or generate titles first.');
  if (!input.thumbnails.length) throw new Error('Make the thumbnails first.');
  if (!input.llm.supportsVision) throw new Error('Scoring needs an LLM that can see images (Gemini or Claude) for the script stage.');
  const queries = nicheQueries(input.topic, titles[0]);
  const query = queries[0] ?? titles[0];

  let competitors = await nicheVideos(queries, { fetcher }).catch((err) => {
    console.warn('[Packaging] Niche videos unavailable:', err instanceof Error ? err.message : err);
    return [] as NicheVideo[];
  });
  // Only the competitors whose thumbnail loaded, so image numbers line up
  const loaded = await Promise.all(competitors.map((c) => fetchImage(c.thumbUrl, fetcher)));
  competitors = competitors.filter((_, i) => loaded[i]);
  const images = [...loaded.filter((x): x is LlmImage => Boolean(x))];
  for (const t of input.thumbnails) images.push(await feedSized(path.isAbsolute(t.path) ? t.path : path.join(process.cwd(), t.path)));

  const thumbnailTexts = input.thumbnails.map((t) => t.text);
  const { data } = await input.llm.generateJson(
    {
      system: 'You judge YouTube titles and thumbnails as a viewer meets them, small, in a crowded feed. You are candid and specific.',
      prompt: buildScorePrompt({ topic: query, summary: input.summary, titles, thumbnailTexts, competitors }),
      schema: ScoreSchema,
      images,
      maxTokens: 6000,
    },
    input.ctx,
  );
  const pairs = normalizePairs(data.pairs, titles.length, input.thumbnails.length);
  // Off-topic search results were left out of the judgement; leave them off the page too
  const offTopic = new Set((data.off_topic ?? []).map((n) => Math.round(n) - 1));
  const onTopic = competitors.filter((_, i) => !offTopic.has(i));
  if (!pairs.length) throw new Error('The scoring came back empty; try again.');
  return {
    scoredAt: (input.now ?? new Date()).toISOString(),
    query,
    competitors: onTopic,
    titles,
    thumbnailTexts,
    pairs,
    best: bestPairs(pairs),
    niche: onTopic.length ? data.niche.trim().slice(0, 600) : '',
    advice: data.advice.map((a) => a.trim()).filter(Boolean).slice(0, 3),
  };
}

/** Whether a score still matches the titles and thumbnails on the page. */
export function scoreIsCurrent(score: PackagingScore, titles: string[], thumbnailTexts: string[]): boolean {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const current = [...new Set(titles.map((t) => t.trim()).filter(Boolean))].slice(0, MAX_TITLES);
  return same(score.titles, current) && same(score.thumbnailTexts, thumbnailTexts);
}
