import type { Browser } from 'playwright';
import type { LLMProvider, ProviderCallContext } from '../providers/types';
import { NewspaperSpecSchema, type NewspaperSpec } from './types';
import { renderNewspaperToMp4, renderNewspaperToPng } from './newspaper-renderer';
import { callLlmJsonWithRetry } from '../providers/llm-retry';

const KNOWN_OUTLETS = [
  'The New York Times',
  'The Wall Street Journal',
  'The Washington Post',
  'Financial Times',
  'The Guardian',
  'Bloomberg',
  'Reuters',
  'Forbes',
  'Daily Mail',
  'The Times',
  'Associated Press',
  'Chicago Tribune',
  'Los Angeles Times',
];

/**
 * Extracts a structured NewspaperSpec using deterministic pattern matching and heuristics.
 */
export function extractNewspaperHeuristic(
  text: string,
  visualQuery?: string,
): NewspaperSpec {
  const combined = `${visualQuery || ''} ${text}`;

  // 1. Detect outlet
  let outlet = 'THE DAILY CHRONICLE';
  for (const known of KNOWN_OUTLETS) {
    if (new RegExp(`\\b${known}\\b`, 'i').test(combined)) {
      outlet = known.toUpperCase();
      break;
    }
  }

  // 2. Detect year or date
  let date: string | undefined;
  const dateMatch = combined.match(/\b(?:in|on|dated)?\s*((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b/i);
  if (dateMatch) {
    date = dateMatch[1].toUpperCase();
  } else {
    const yearMatch = combined.match(/\b(19\d\d|20\d\d)\b/);
    if (yearMatch) {
      date = `FALL, ${yearMatch[1]}`;
    }
  }

  // 3. Extract quotes or highlighted statements
  const quoteMatch = combined.match(/["“]([^"”]{6,120})["”]/);
  const highlightText = quoteMatch ? quoteMatch[1] : undefined;

  // 4. Headline generation
  // If there's a visual query with words like "newspaper with headline X", extract X
  let headline = 'BREAKING REPORT';
  const queryHeadlineMatch = visualQuery?.match(/(?:headline|front page|article)\s*[:"“-]?\s*([^"”\n.]{8,80})/i);
  if (queryHeadlineMatch) {
    headline = queryHeadlineMatch[1].trim().toUpperCase();
  } else if (highlightText && highlightText.length <= 60) {
    headline = highlightText.toUpperCase();
  } else {
    // Take the first punchy clause of text
    const firstClause = text.split(/[.,;:—]/)[0]?.trim();
    if (firstClause && firstClause.length >= 8) {
      headline = firstClause.slice(0, 70).toUpperCase();
    }
  }

  // 5. Subheadline & snippet
  const subheadline = text.length > headline.length + 15
    ? text.slice(0, 140).trim()
    : 'Special dispatch examines sweeping ramifications worldwide';

  return {
    outlet,
    date,
    edition: 'LATE CITY EDITION',
    headline,
    subheadline,
    snippet: text,
    highlightText: highlightText || headline,
    highlightColor: 'yellow',
    style: 'vintage',
  };
}

/**
 * Extracts a structured NewspaperSpec, attempting LLM extraction first if available,
 * falling back gracefully to heuristic parsing.
 */
export async function extractNewspaperSpec(
  text: string,
  visualQuery?: string,
  llmProvider?: LLMProvider | null,
  llmCtx?: ProviderCallContext | null,
): Promise<NewspaperSpec> {
  if (llmProvider && llmCtx) {
    try {
      const system = `You are a visual documentary producer for an archival video pipeline.
Extract a structured newspaper front-page specification from the beat narration.
Output JSON conforming to the schema with:
- outlet: The publication name (e.g. "THE NEW YORK TIMES", "THE WALL STREET JOURNAL", "DAILY TELEGRAPH"). Default to an authentic major newspaper or "THE CHRONICLE".
- date: Appropriate publication date mentioned or inferred (e.g. "OCTOBER 29, 1929").
- edition: e.g. "LATE CITY EDITION".
- headline: Bold, dramatic broadsheet headline summarizing the key historical moment or event (ALL CAPS, punchy, 4-10 words).
- subheadline: 1 sentence italicized deck explaining the headline.
- snippet: The narrative context or paragraph containing the key sentence.
- highlightText: The single most impactful sentence or phrase that should be highlighted with a yellow marker.
- highlightColor: "yellow" | "cyan" | "green" | "rose".
- style: "vintage" | "modern" | "dark".`;

      const prompt = `Narration Text: "${text}"\nVisual Direction: "${visualQuery || ''}"`;

      const res = await callLlmJsonWithRetry(
        llmProvider,
        {
          system,
          prompt,
          schema: NewspaperSpecSchema,
          maxTokens: 500,
        },
        llmCtx,
        1,
        '[NewspaperSpec]',
      );

      if (res.data?.headline) {
        return res.data;
      }
    } catch {
      // LLM call failed or returned invalid JSON; fallback to heuristics
    }
  }

  return extractNewspaperHeuristic(text, visualQuery);
}

export interface NewspaperStepInput {
  text: string;
  visualQuery?: string;
  durationSeconds: number;
  outputMp4Path: string;
  tempDir: string;
  llmProvider?: LLMProvider | null;
  llmCtx?: ProviderCallContext | null;
  browser?: Browser;
  asVideo?: boolean;
}

export interface NewspaperStepResult {
  success: boolean;
  outputPath?: string;
  spec?: NewspaperSpec;
  error?: string;
}

/**
 * Executes the complete newspaper visualization step:
 * Parses spec -> renders animated MP4 or high-res PNG -> returns output.
 */
export async function executeNewspaperStep(
  input: NewspaperStepInput,
): Promise<NewspaperStepResult> {
  const {
    text,
    visualQuery,
    durationSeconds,
    outputMp4Path,
    tempDir,
    llmProvider,
    llmCtx,
    browser,
    asVideo = true,
  } = input;

  try {
    const spec = await extractNewspaperSpec(text, visualQuery, llmProvider, llmCtx);

    if (asVideo) {
      await renderNewspaperToMp4(spec, outputMp4Path, durationSeconds, tempDir, browser);
    } else {
      const pngPath = outputMp4Path.replace(/\.mp4$/i, '.png');
      await renderNewspaperToPng(spec, pngPath, browser);
      return {
        success: true,
        outputPath: pngPath,
        spec,
      };
    }

    return {
      success: true,
      outputPath: outputMp4Path,
      spec,
    };
  } catch (err) {
    return {
      success: false,
      error: `Newspaper visual step failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
