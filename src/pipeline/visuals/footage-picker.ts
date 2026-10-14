import { z } from 'zod';
import type { ShotPlan } from '@/lib/script/generate-script';
import { searchArchiveOrg } from '../providers/stock/archive-org';
import { searchWikimediaCommons } from '../providers/stock/wikimedia';
import type { LLMProvider, LlmImage, ProviderCallContext, StockProvider } from '../providers/types';
import { isUnusableLicense } from '../utils/media-upload';
import type { MediaCandidate } from './types';

/**
 * Finds footage that actually shows what the shot is about. Searches the archives and stock
 * library with several phrasings of the director's query, then (when the LLM can see images)
 * has it rate each candidate's thumbnail, so a rock concert never stands in for a 1931 bank run.
 */

/** Words that describe style or mood: they narrow searches without adding meaning. */
const STYLE_WORDS = new Set([
  'frantic', 'dramatic', 'cinematic', 'moody', 'dark', 'bright', 'vintage', 'historic', 'historical',
  'archival', 'archive', 'footage', 'photo', 'photograph', 'photography', 'film', 'black', 'white',
  'sepia', 'close', 'closeup', 'close-up', 'shot', 'wide', 'aerial', 'slow', 'motion', 'mood',
  'atmosphere', 'scene', 'view', 'exterior', 'interior', 'facade', 'shouting', 'anxious', 'desperate',
  'busy', 'crowded', 'empty', 'beautiful', 'stunning', 'epic', 'tense', 'chaotic', 'chaos', 'shadows',
  'falling', 'graphic', 'animated', 'animation', 'b-roll', 'broll', 'background', 'texture', 'hd', '4k',
]);
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'and', 'or', 'with', 'to', 'for', 'from', 'by', 'during', 'as']);
const YEAR = /^(?:1[5-9]\d{2}|20\d{2})s?$/;

/** Different phrasings of a shot's query, most specific first. */
export function queryVariants(query: string): string[] {
  const words = query.replace(/[,;:()"“”]/g, ' ').split(/\s+/).filter(Boolean);
  const isStyle = (w: string) => STYLE_WORDS.has(w.toLowerCase());
  const years = words.filter((w) => YEAR.test(w));
  // Runs of capitalised words are names: "New York Stock Exchange", "Irving Fisher"
  const names: string[] = [];
  let run: string[] = [];
  for (const w of words) {
    const capital = /^[A-Z][\p{L}.'’-]*$/u.test(w) && !YEAR.test(w);
    if (capital || (run.length && STOP_WORDS.has(w.toLowerCase()) && w === w.toLowerCase() && w.length <= 3)) run.push(w);
    else {
      if (run.length) names.push(run.join(' ').replace(/\s+(?:of|the|and|in|on)$/i, ''));
      run = [];
    }
  }
  if (run.length) names.push(run.join(' '));
  const nouns = words.filter((w) => !YEAR.test(w) && !isStyle(w) && !STOP_WORDS.has(w.toLowerCase()) && w === w.toLowerCase());

  // Archives often file people by surname and year: "Roosevelt 1933"
  const surname = names[0]?.split(/\s+/).filter((w) => w.length > 2).pop();
  const variants = [
    words.filter((w) => !isStyle(w)).slice(0, 8).join(' '),
    [...names, ...years].join(' '),
    surname && surname !== names[0] ? [surname, ...years.slice(0, 1)].join(' ') : '',
    [names[0], ...nouns.slice(0, 2), ...years.slice(0, 1)].filter(Boolean).join(' '),
    names[0] ?? '',
    [...years.slice(0, 1), ...nouns.slice(0, 3)].join(' '),
  ];
  // Every phrasing needs a subject: a year alone ("1920s") matches anything from that decade
  return [...new Set(variants.map((v) => v.trim()).filter((v) => v.split(/\s+/).some((w) => !YEAR.test(w)) && v.length >= 3))];
}

/**
 * The broadest useful phrasing: a named subject's surname, or else the first two subject words
 * (plus the year for archives).
 */
export function broadQueryFor(query: string, withYear: boolean): string {
  const words = query.replace(/[,;:()"“”]/g, ' ').split(/\s+/).filter(Boolean);
  const subjects = words.filter((w) => !YEAR.test(w) && !STYLE_WORDS.has(w.toLowerCase()) && !STOP_WORDS.has(w.toLowerCase()));
  const year = withYear ? words.find((w) => YEAR.test(w)) : undefined;
  const capitalised = subjects.filter((w) => /^[A-Z][\p{L}'’-]{2,}$/u.test(w));
  const core = capitalised.length >= 2 ? [capitalised[capitalised.length - 1]] : subjects.slice(0, 2);
  return [...core, ...(year ? [year] : [])].join(' ');
}

/** Pages and versions of one file share a title apart from numbers: "(Speech) page 3.jpg". */
const titleFamily = (title = '') =>
  title
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')
    .replace(/[\d_()[\]-]+/g, ' ')
    .replace(/\b(page|p|part|version|crop|cropped)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);

/** A stock-library phrasing: concrete subjects only (no names or years, which stock lacks). */
export function stockQueryFor(query: string): string {
  const words = query.replace(/[,;:()"“”]/g, ' ').split(/\s+/).filter(Boolean);
  const nouns = words.filter((w) => !YEAR.test(w) && !STYLE_WORDS.has(w.toLowerCase()) && !STOP_WORDS.has(w.toLowerCase()));
  return nouns.slice(0, 5).join(' ') || query;
}

const candidateKey = (c: MediaCandidate) => String(c.pageUrl || c.downloadUrl || c.id);

export interface GatherOptions {
  shot: ShotPlan;
  stockProvider?: StockProvider;
  stockCtx?: ProviderCallContext;
  /** Candidates already used in the video. */
  exclude?: Set<string>;
  maxCandidates?: number;
  /** Second attempt after nothing relevant was found: broad phrasings only. */
  broad?: boolean;
}

/**
 * Collects candidates from every source that suits the shot: archive shots search Wikimedia and
 * archive.org first (with each query phrasing in turn), then stock as an option; stock shots
 * search the stock library first, with archive photos as an option.
 */
export async function gatherCandidates(options: GatherOptions): Promise<MediaCandidate[]> {
  const { shot, stockProvider, stockCtx, exclude, maxCandidates = 15 } = options;
  const out: MediaCandidate[] = [];
  const seen = new Set<string>();
  const families = new Set<string>();
  const add = (items: MediaCandidate[], cap = maxCandidates) => {
    for (const item of items) {
      if (out.length >= cap) break;
      const key = candidateKey(item);
      // One candidate per family, so five pages of one scanned document don't crowd out the rest
      const family = titleFamily(item.title);
      if (seen.has(key) || exclude?.has(key) || isUnusableLicense(item.license) || (family && families.has(family))) continue;
      seen.add(key);
      if (family) families.add(family);
      out.push(item);
    }
  };
  const safe = async <T>(p: Promise<T[]>): Promise<T[]> => p.catch(() => [] as T[]);
  const stock = async (q: string): Promise<MediaCandidate[]> => {
    if (!stockProvider || !stockCtx?.apiKey || !q) return [];
    const hits = await stockProvider.searchVideos(q, stockCtx).catch(() => []);
    return hits.map((hit) => ({
      id: `stock_${hit.id}`,
      provider: 'pixabay' as const,
      mediaType: 'video' as const,
      title: hit.tags || q,
      thumbnailUrl: hit.thumbnailUrl ?? '',
      // 1080p is all the output needs; 4K files are several times larger to download
      downloadUrl: (hit.files?.find((f) => f.quality === 'medium' && f.width >= 1920) ?? hit.files?.[0])?.url ?? hit.url,
      pageUrl: hit.pageUrl,
      duration: hit.duration,
      width: hit.width,
      height: hit.height,
      attribution: hit.attribution || 'Pixabay Contributor',
      license: 'royalty_free',
      licenseProofUrl: 'https://pixabay.com/service/license-summary/',
    }));
  };

  if (options.broad) {
    const archive = shot.visual_type === 'archive';
    const q = broadQueryFor(shot.visual_query, archive);
    const [wiki, stockHits] = await Promise.all([
      safe(searchWikimediaCommons(q, { limit: 6 })),
      stock(broadQueryFor(shot.visual_query, false)),
    ]);
    add(archive ? [...wiki, ...stockHits] : [...stockHits, ...wiki]);
    return out;
  }

  const variants = queryVariants(shot.visual_query);
  if (shot.visual_type === 'archive') {
    // A few of the best from each phrasing, so later phrasings get a say
    const archiveCap = maxCandidates - 3;
    for (const q of variants) {
      if (out.length >= archiveCap) break;
      const [wiki, archive] = await Promise.all([
        safe(searchWikimediaCommons(q, { limit: 6 })),
        safe(searchArchiveOrg(q, { limit: 3 })),
      ]);
      add([...wiki.slice(0, 4), ...archive.slice(0, 1)], Math.min(archiveCap, out.length + 4));
    }
    add(await stock(stockQueryFor(shot.visual_query)));
  } else {
    add(await stock(variants[0] ?? shot.visual_query), maxCandidates - 3);
    if (out.length < maxCandidates - 3) add(await stock(stockQueryFor(shot.visual_query)), maxCandidates - 3);
    add(await safe(searchWikimediaCommons(variants[1] ?? variants[0] ?? shot.visual_query, { limit: 4 })));
  }
  return out;
}

// --------------------------------------------------------------------------
// Ranking
// --------------------------------------------------------------------------

/** Below this vision score, a candidate is treated as not showing the shot at all. */
export const MIN_RELEVANCE = 6;
const MAX_THUMB_BYTES = 1_500_000;

export interface RankedCandidate {
  candidate: MediaCandidate;
  score: number;
  reason?: string;
}

const RatingSchema = z.object({
  ratings: z.array(
    z.object({
      index: z.number(),
      score: z.number(),
      era_ok: z.boolean(),
      subject_match: z.boolean(),
      reason: z.string(),
    }),
  ),
});
/** The most a candidate can score without showing the person, place, or event the shot names. */
const OFF_SUBJECT_CAP = 5;

async function fetchThumbnail(url: string): Promise<LlmImage | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'YT-Automation/1.0 (footage relevance check)' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mimeType)) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_THUMB_BYTES) return null;
    return { mimeType, data: bytes.toString('base64') };
  } catch {
    return null;
  }
}

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t) && !STYLE_WORDS.has(t)),
  );

/** Ranking without vision: words shared between the query and the candidate's title or tags. */
export function heuristicRank(shot: ShotPlan, candidates: MediaCandidate[]): RankedCandidate[] {
  const want = tokens(shot.visual_query);
  return candidates
    .map((candidate, i) => {
      const have = tokens(`${candidate.title ?? ''}`);
      const shared = [...want].filter((t) => have.has(t)).length;
      const sourceFit = shot.visual_type === 'archive' ? (candidate.provider === 'pixabay' ? -1 : 1) : 0;
      // Earlier results from a source are its own best matches; keep that as a tie-breaker
      return { candidate, score: shared * 2 + sourceFit - i * 0.01 };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Rates candidates by looking at their thumbnails. Returns them best first, each with a 0-10
 * score; anything under MIN_RELEVANCE doesn't show the shot. Throws when vision is unavailable
 * so the caller can fall back to the heuristic.
 */
export async function visionRank(
  shot: ShotPlan,
  candidates: MediaCandidate[],
  llm: LLMProvider,
  ctx: ProviderCallContext,
): Promise<RankedCandidate[]> {
  if (!llm.supportsVision) throw new Error(`${llm.id} cannot see images`);
  const thumbs = await Promise.all(candidates.map((c) => fetchThumbnail(c.thumbnailUrl)));
  const shown = candidates.map((c, i) => ({ c, img: thumbs[i] })).filter((x) => x.img);
  if (shown.length === 0) throw new Error('No candidate thumbnails could be loaded');

  const historical = shot.visual_type === 'archive';
  // A named period applies to b-roll too: a 2002 spreadsheet can't illustrate 1929
  const era = shot.visual_query.match(/\b(1[5-9]\d{2}|20\d{2})s?\b/)?.[0];
  const periodBound = historical || Boolean(era);
  const prompt = `You are picking footage for one shot of a documentary.
Shot: ${shot.visual_query}
Narration heard over it: "${shot.covers}"
${historical ? 'This is a HISTORICAL shot: it must look like a real photo or film from the period described.' : 'This is b-roll: it should clearly show the subject, in a style that fits the narration.'}
${era ? `The story is set in ${era}: anything visibly from another era (modern devices, cars, clothing, printed dates) is wrong.` : ''}
${shot.caption?.name ? `It is captioned "${shot.caption.name}", so it must show that person or place.` : ''}

The images, in order:
${shown.map(({ c }, i) => `${i + 1}. ${c.mediaType === 'video' ? 'a film' : 'a photo'} titled "${String(c.title ?? '').slice(0, 120)}"${c.mediaType === 'video' ? ' (its thumbnail; old films often open on a title card, so judge what the film shows from the thumbnail and title together)' : ''}`).join('\n')}

Rate each of the ${shown.length} images below (numbered 1 to ${shown.length} in order) from 0 to 10 for how well it would show this shot to a viewer:
10 = exactly the subject; 7 = clearly the right subject or place; 4 = loosely related; 0 = unrelated or misleading.
If the shot names a specific person, place, building, or event, an image that doesn't show it scores at most 5, even when it is from the right period.
Score low for: the wrong era (modern scenes in a historical shot), a different named person or place, watermarks or large text overlays, posters, book covers, pages of text, collages, or maps.
era_ok: false if the image is clearly from the wrong period for this shot.
subject_match: false if the shot names a specific person, place, building, or event and the image does not show it; true otherwise.
Return one rating per image with its index (1-based).`;

  const { data } = await llm.generateJson(
    { prompt, schema: RatingSchema, images: shown.map((x) => x.img!), maxTokens: 1500 },
    ctx,
  );
  const byIndex = new Map(data.ratings.map((r) => [r.index, r]));
  return shown
    .map(({ c }, i) => {
      const r = byIndex.get(i + 1);
      let score = r ? r.score : 0;
      if (r && !r.subject_match) score = Math.min(score, OFF_SUBJECT_CAP);
      if (r && periodBound && !r.era_ok) score -= 3;
      // Motion beats a still when both fit
      if (c.mediaType === 'video') score += 0.3;
      return { candidate: c, score, reason: r?.reason };
    })
    .sort((a, b) => b.score - a.score);
}

export interface PickFootageOptions extends GatherOptions {
  llmProvider?: LLMProvider;
  llmCtx?: ProviderCallContext;
}

/**
 * Candidates for a shot, best first. With vision, only candidates that clearly show the shot are
 * returned (possibly none); without it, every candidate in heuristic order.
 */
export async function pickFootage(options: PickFootageOptions): Promise<{ ranked: RankedCandidate[]; checked: boolean }> {
  const candidates = await gatherCandidates(options);
  if (options.llmProvider?.supportsVision && options.llmCtx && candidates.length > 0) {
    try {
      const ranked = (await visionRank(options.shot, candidates, options.llmProvider, options.llmCtx)).filter(
        (r) => r.score >= MIN_RELEVANCE,
      );
      if (ranked.length > 0) return { ranked, checked: true };
      // Nothing showed the shot: one more try with the broadest phrasing
      const seen = new Set([...(options.exclude ?? []), ...candidates.map(candidateKey)]);
      const broad = await gatherCandidates({ ...options, exclude: seen, broad: true });
      if (broad.length === 0) return { ranked: [], checked: true };
      const second = await visionRank(options.shot, broad, options.llmProvider, options.llmCtx);
      return { ranked: second.filter((r) => r.score >= MIN_RELEVANCE), checked: true };
    } catch (err) {
      console.warn(`[FootagePicker] Vision check unavailable (${err instanceof Error ? err.message.slice(0, 160) : err}); ranking by title`);
    }
  }
  return { ranked: heuristicRank(options.shot, candidates), checked: false };
}
