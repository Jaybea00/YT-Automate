/** Advertiser-friendly check types and the local swearing check, safe to use in the browser. */

export const AD_CATEGORIES = [
  'language',
  'violence',
  'shocking',
  'adult',
  'harmful_acts',
  'drugs',
  'firearms',
  'hateful',
  'sensitive_events',
  'controversial',
] as const;
export type AdCategory = (typeof AD_CATEGORIES)[number];

export const AD_CATEGORY_LABEL: Record<AdCategory, string> = {
  language: 'Strong language',
  violence: 'Graphic violence',
  shocking: 'Shocking or gory detail',
  adult: 'Sexual content',
  harmful_acts: 'Dangerous or harmful acts',
  drugs: 'Drug use',
  firearms: 'Weapons detail',
  hateful: 'Hateful wording',
  sensitive_events: 'Tragedy told vividly',
  controversial: 'Controversial issue told graphically',
};

/** "limited": likely to get limited or no ads as written. "caution": borderline. */
export type AdSeverity = 'limited' | 'caution';

export interface AdCheckIssue {
  id: string;
  beat_index: number;
  category: AdCategory;
  severity: AdSeverity;
  /** The words in the beat the issue is about. */
  quote: string;
  problem: string;
  /** The whole beat, rewritten to be advertiser-friendly. */
  suggested_text?: string;
  checked_text: string;
  dismissed?: boolean;
}

export interface AdTitleIssue {
  title: string;
  problem: string;
  suggestion?: string;
}

export interface AdCheckReport {
  checkedAt: string;
  model?: string;
  beatsChecked: number;
  issues: AdCheckIssue[];
  titleIssues: AdTitleIssue[];
  /** True when the model check failed and only the built-in swearing check ran. */
  localOnly?: boolean;
}

/**
 * Strong profanity, the kind that limits ads when it's in the opening seconds or used often.
 * Mild words (damn, hell, crap) are fine for YouTube and aren't listed.
 */
const STRONG_PROFANITY = /\b(f+u+c+k\w*|motherf\w*|sh[i1]t\w*|c+u+n+t\w*|bullshit\w*|bitch\w*|bastard\w*|asshole\w*|dickhead\w*|wank\w*|twat\w*)\b/gi;

/** About the first 7 seconds of narration, where YouTube is strictest about swearing. */
const OPENING_WORDS = 18;

/** Finds strong swearing without a model call, so it's caught even when the check can't run. */
export function findProfanity(beats: Array<{ index: number; text: string }>): AdCheckIssue[] {
  const issues: AdCheckIssue[] = [];
  let wordsBefore = 0;
  for (const beat of beats) {
    const words = [...beat.text.matchAll(STRONG_PROFANITY)].map((m) => m[0]);
    if (words.length) {
      // Position of the first swear word in the whole narration
      const offset = beat.text.slice(0, beat.text.search(STRONG_PROFANITY)).split(/\s+/).filter(Boolean).length;
      const opening = wordsBefore + offset < OPENING_WORDS;
      issues.push({
        id: `ad-${beat.index}-lang`,
        beat_index: beat.index,
        category: 'language',
        severity: opening ? 'limited' : 'caution',
        quote: [...new Set(words.map((w) => w.toLowerCase()))].join(', '),
        problem: opening
          ? 'Strong swearing in the opening seconds usually means limited ads.'
          : 'Strong swearing; used more than occasionally it can limit ads.',
        checked_text: beat.text,
      });
    }
    wordsBefore += beat.text.split(/\s+/).filter(Boolean).length;
  }
  return issues;
}
