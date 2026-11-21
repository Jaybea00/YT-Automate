import { asContrastShort, contrastMinutes, contrastSetupFrom, type ContrastSetup } from './contrast';
import { asRankingShort, isRankingSize, rankingMinutes, type RankingSize } from './ranking';

/**
 * Shorts made on their own from New video: a ranking (countdown) or a contrast (two sides). One
 * place turns the form's choice into the request, the writer's rules, the length and the saved
 * script. Browser-safe.
 */

export interface ShortFormatRequest {
  shortFormat?: 'ranking' | 'contrast' | null;
  /** A ranking's size: Top 5 (default) or Top 10. */
  rankingItems?: RankingSize | null;
  /** A contrast's labels and length. */
  contrast?: ContrastSetup | null;
}

/** The short format a request body asks for (unusable choices are dropped). */
export function shortFormatFrom(body: unknown): ShortFormatRequest {
  const b = (body ?? {}) as { shortFormat?: unknown; rankingItems?: unknown; contrast?: unknown };
  if (b.shortFormat === 'ranking') {
    const n = Number(b.rankingItems);
    return { shortFormat: 'ranking', rankingItems: isRankingSize(n) ? n : 5 };
  }
  if (b.shortFormat === 'contrast') {
    const contrast = contrastSetupFrom(b.contrast);
    if (contrast) return { shortFormat: 'contrast', contrast };
  }
  return {};
}

/** The narration length the format asks for, or null for a normal video. */
export function shortFormatMinutes(req: ShortFormatRequest): number | null {
  if (req.shortFormat === 'ranking') return rankingMinutes(isRankingSize(req.rankingItems) ? req.rankingItems : 5);
  if (req.shortFormat === 'contrast' && req.contrast) return contrastMinutes(req.contrast.length);
  return null;
}

/** What the script writer needs to know. */
export function shortFormatWriterInput(req: ShortFormatRequest) {
  if (req.shortFormat === 'ranking') return { format: 'short' as const, ranking: true, rankingItems: isRankingSize(req.rankingItems) ? req.rankingItems : (5 as RankingSize) };
  if (req.shortFormat === 'contrast' && req.contrast) return { format: 'short' as const, contrast: req.contrast };
  return {};
}

/** The finished script marked as that kind of Short (unchanged for a normal video). */
export function withShortFormat<T extends object>(script: T, req: ShortFormatRequest, hookBanner?: string | null): T {
  if (req.shortFormat === 'ranking') return asRankingShort(script, hookBanner);
  if (req.shortFormat === 'contrast' && req.contrast) return asContrastShort(script, req.contrast, hookBanner) as T;
  return script;
}

export const isShortFormat = (req: ShortFormatRequest) => Boolean(req.shortFormat === 'ranking' || (req.shortFormat === 'contrast' && req.contrast));
