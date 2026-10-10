import type { LLMProvider, ProviderCallContext } from '../providers/types';
import { callLlmTextWithRetry } from '../providers/llm-retry';

const META_WORDS = new Set([
  'showing',
  'shows',
  'show',
  'comparing',
  'compares',
  'compared',
  'comparison',
  'live',
  'dashboard',
  'visual',
  'visuals',
  'footage',
  'clip',
  'video',
  'recording',
  'screen',
  'chart',
  'charts',
  'graph',
  'graphs',
  'map',
  'maps',
  'diagram',
  'illustration',
  'concept',
  'versus',
  'vs',
  'against',
  'close-up',
  'closeup',
  'aerial',
  'overhead',
  'drone',
  'wide',
  'shot',
  'b-roll',
  'broll',
  'slow',
  'motion',
  'time-lapse',
  'timelapse',
  '4k',
  'hd',
  'macro',
  'cinematic',
  'scene',
  'scenes',
  'photo',
  'view',
  'views',
  'animation',
  'graphic',
  'graphics',
  'display',
  'interface',
]);

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for',
  'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers',
  'herself', 'him', 'himself', 'his', 'how', 'if', 'in', 'into', 'is', 'it', 'its',
  'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves',
  'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that',
  'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would',
  'you', 'your', 'yours', 'yourself', 'yourselves', 'low', 'high',
]);

/**
 * Heuristically extracts 3-5 concise, concrete keywords from a descriptive visual query.
 * Strips camera/meta-direction words and common English stop words.
 */
export function extractKeywordsHeuristic(query: string, maxWords: number = 4): string {
  if (!query) return '';

  // Clean and split words
  const rawWords = query
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

  // Filter out meta-words and stop-words
  const contentWords = rawWords.filter(
    (w) => !META_WORDS.has(w) && !STOP_WORDS.has(w) && w.length >= 3,
  );

  // If filtering left at least 2 strong content words, use them
  if (contentWords.length >= 2) {
    return contentWords.slice(0, maxWords).join(' ');
  }

  // Fallback: take first N raw words that are at least 3 chars
  const fallback = rawWords.filter((w) => !STOP_WORDS.has(w) && w.length >= 3);
  if (fallback.length > 0) {
    return fallback.slice(0, maxWords).join(' ');
  }

  // Extreme fallback
  return rawWords.slice(0, maxWords).join(' ') || query.slice(0, 30).trim();
}

/**
 * Converts a long descriptive visual_query into a concise 3-5 word keyword search phrase
 * specifically for stock video APIs (Pixabay, Pexels), keeping the original descriptive
 * visual_query intact in script_json and provenance logs.
 *
 * Reuses the bound LLM provider if available, with immediate smart heuristic fallback.
 */
export async function extractStockKeywords(
  query: string,
  llmProvider?: LLMProvider | null,
  llmCtx?: ProviderCallContext | null,
): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) {
    return '';
  }

  // If query is already short (<= 4 words and <= 35 characters), keep as is
  const words = trimmed.split(/\s+/);
  if (words.length <= 4 && trimmed.length <= 35) {
    return trimmed;
  }

  // Attempt LLM keyword distillation if provider is bound
  if (llmProvider && llmCtx) {
    try {
      const response = await callLlmTextWithRetry(
        llmProvider,
        {
          system:
            'You are an assistant that extracts 2 to 4 concrete, physical stock video search keywords from a visual description. Return ONLY the keywords separated by spaces. Do not use quotes, punctuation, or explanations. Focus on visible physical objects or settings (e.g. "nuclear power plant", "solar panels aerial", "electricity power grid").',
          prompt: `Visual description: "${trimmed}"\nKeywords:`,
          maxTokens: 25,
          temperature: 0.1,
        },
        llmCtx,
        2,
        '[StockKeywords]',
      );

      const llmResult = response.text
        ?.replace(/["'`.\n\r]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (llmResult && llmResult.length > 0 && llmResult.length <= 60) {
        const resultWords = llmResult.split(/\s+/);
        if (resultWords.length >= 1 && resultWords.length <= 6) {
          return llmResult;
        }
      }
    } catch (err) {
      console.warn(
        `[StockKeywords] LLM keyword extraction failed, falling back to heuristic:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Deterministic heuristic fallback
  return extractKeywordsHeuristic(trimmed, 4);
}
