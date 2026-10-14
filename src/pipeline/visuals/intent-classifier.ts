export type VisualIntent =
  | 'archive'
  | 'nasa_space'
  | 'geo_map'
  | 'chart'
  | 'screen_recording'
  | 'newspaper'
  | 'stock';

export interface ClassifiedIntent {
  intent: VisualIntent;
  keywords: string;
  confidence: number;
}

const SPACE_KEYWORDS = [
  'space',
  'planet',
  'mars',
  'jupiter',
  'saturn',
  'moon',
  'nasa',
  'astronaut',
  'galaxy',
  'universe',
  'telescope',
  'hubble',
  'james webb',
  'rocket',
  'apollo',
  'nebula',
  'solar system',
  'orbit',
  'cosmic',
  'asteroid',
  'iss',
];

const ARCHIVE_KEYWORDS = [
  'history',
  'historical',
  'century',
  '19th century',
  '20th century',
  '18th century',
  '17th century',
  '1900s',
  '1910s',
  '1920s',
  '1930s',
  '1940s',
  '1950s',
  '1960s',
  '1970s',
  'world war',
  'ww1',
  'ww2',
  'ancient',
  'emperor',
  'empire',
  'president',
  'einstein',
  'churchill',
  'roosevelt',
  'vintage',
  'archival',
  'civil war',
  'revolution',
  'manuscript',
  'monument',
  'museum',
];

const GEO_KEYWORDS = [
  'miles east',
  'miles west',
  'miles north',
  'miles south',
  'located in',
  'border between',
  'from to',
  'route from',
  'highway',
  'corridor',
  'map of',
];

const NEWSPAPER_KEYWORDS = [
  'newspaper',
  'headline',
  'front page',
  'press release',
  'article',
  'wall street journal',
  'washington post',
  'new york times',
  'financial times',
  'reuters reported',
  'bloomberg reported',
  'broadsheet',
  'daily chronicle',
];

/**
 * Classifies semantic visual intent and extracts distilled search keywords.
 */
export function classifyVisualIntent(
  text: string,
  visualQuery?: string,
  explicitType?: string,
): ClassifiedIntent {
  if (explicitType === 'chart') {
    return { intent: 'chart', keywords: visualQuery || text, confidence: 1.0 };
  }
  if (explicitType === 'screen_recording') {
    return { intent: 'screen_recording', keywords: visualQuery || text, confidence: 1.0 };
  }
  if (explicitType === 'newspaper') {
    return { intent: 'newspaper', keywords: visualQuery || text, confidence: 1.0 };
  }

  const combined = `${visualQuery || ''} ${text}`.toLowerCase();

  // Check Newspaper / Press Headline
  for (const kw of NEWSPAPER_KEYWORDS) {
    if (combined.includes(kw)) {
      return {
        intent: 'newspaper',
        keywords: distillKeywords(visualQuery || text),
        confidence: 0.9,
      };
    }
  }

  // Check Space / NASA
  for (const kw of SPACE_KEYWORDS) {
    if (combined.includes(kw)) {
      return {
        intent: 'nasa_space',
        keywords: distillKeywords(visualQuery || text),
        confidence: 0.9,
      };
    }
  }

  // Check Historical / Archive
  for (const kw of ARCHIVE_KEYWORDS) {
    if (combined.includes(kw)) {
      return {
        intent: 'archive',
        keywords: distillKeywords(visualQuery || text),
        confidence: 0.85,
      };
    }
  }

  // Check Geo / Map
  for (const kw of GEO_KEYWORDS) {
    if (combined.includes(kw)) {
      return {
        intent: 'geo_map',
        keywords: distillKeywords(visualQuery || text),
        confidence: 0.8,
      };
    }
  }

  // Default to general real-world stock
  return {
    intent: 'stock',
    keywords: distillKeywords(visualQuery || text),
    confidence: 0.7,
  };
}

/**
 * Distills query into concise search keywords suitable for media search APIs.
 */
function distillKeywords(text: string): string {
  const clean = text
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = clean.split(' ').filter((w) => w.length > 2);
  const stopWords = new Set([
    'the', 'and', 'that', 'with', 'from', 'this', 'have', 'were', 'which',
    'their', 'about', 'would', 'there', 'could', 'other', 'into', 'first',
    'more', 'these', 'show', 'clip', 'video', 'footage', 'scene', 'b-roll',
  ]);

  const filtered = words.filter((w) => !stopWords.has(w.toLowerCase()));

  if (filtered.length <= 4) {
    return filtered.join(' ');
  }

  // If seed word is provided, ensure words near it or top nouns
  return filtered.slice(0, 4).join(' ');
}
