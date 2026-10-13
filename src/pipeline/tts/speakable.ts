/**
 * Prepares narration for text-to-speech. Voices read some written forms wrongly
 * ("Oct." as "ock-t", "29" in a date as "twenty-nine" instead of "twenty-ninth"), so
 * those are rewritten into their spoken form. Only the voiced text changes; captions and
 * shot plans keep using the original narration.
 */

export interface Pronunciation {
  /** Word or phrase as written in scripts, matched case-insensitively on word boundaries. */
  term: string;
  /** How the voice should say it, e.g. "Creditanstalt" -> "kreh-dit-AHN-shtalt". */
  say: string;
}

const MONTHS: Record<string, string> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  sept: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
};
const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';

/** Abbreviations whose expansion doesn't depend on context. */
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bMr\./g, 'Mister'],
  [/\bMrs\./g, 'Missus'],
  [/\bDr\./g, 'Doctor'],
  [/\bProf\./g, 'Professor'],
  [/\bGen\.(?=\s+[A-Z])/g, 'General'],
  [/\bGov\.(?=\s+[A-Z])/g, 'Governor'],
  [/\bSen\.(?=\s+[A-Z])/g, 'Senator'],
  [/\bRep\.(?=\s+[A-Z])/g, 'Representative'],
  [/\bMt\.(?=\s+[A-Z])/g, 'Mount'],
  [/\bFt\.(?=\s+[A-Z])/g, 'Fort'],
  [/\bJr\./g, 'Junior'],
  [/\bSr\./g, 'Senior'],
  [/\bNo\.(?=\s*\d)/g, 'number'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\betc\./gi, 'et cetera'],
  [/\be\.g\.,?/gi, 'for example,'],
  [/\bi\.e\.,?/gi, 'that is,'],
  [/\bapprox\./gi, 'approximately'],
];

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toSpeakableText(text: string, pronunciations: Pronunciation[] = []): string {
  let out = text;

  // Custom pronunciations first, longest terms first so phrases win over their parts
  for (const { term, say } of [...pronunciations].sort((a, b) => b.term.length - a.term.length)) {
    if (!term.trim() || !say.trim()) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term.trim())}(?![\\p{L}\\p{N}])`, 'giu'), say.trim());
  }

  // Abbreviated months before a day or year: "Oct. 29" -> "October 29"
  out = out.replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.(?=\s*\d)/g, (_, m: string) => MONTHS[m.toLowerCase()]);

  // Day of month after a month name is an ordinal: "October 29, 1929" -> "October 29th, 1929"
  out = out.replace(new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?![\\d:]|st|nd|rd|th)`, 'g'), (_, month: string, day: string) => {
    const n = Number(day);
    return n >= 1 && n <= 31 ? `${month} ${ordinal(n)}` : `${month} ${day}`;
  });

  // "St.": "Wall St." is a street, "St. Louis" is a saint
  out = out.replace(/(\b[A-Z][a-z]+)\s+St\./g, '$1 Street');
  out = out.replace(/\bSt\.(?=\s+[A-Z])/g, 'Saint');

  for (const [pattern, replacement] of ABBREVIATIONS) out = out.replace(pattern, replacement);

  // Year ranges: "1929–1933" -> "1929 to 1933"
  out = out.replace(/\b(1\d{3}|20\d{2})\s*[–—-]\s*(1\d{3}|20\d{2})\b/g, '$1 to $2');

  out = out
    .replace(/\s&\s/g, ' and ')
    .replace(/~\s*(?=[$£€]?\d)/g, 'about ')
    .replace(/\b(\d+(?:\.\d+)?)[x×](?![\p{L}\p{N}])/gu, '$1 times');

  return out.replace(/\s{2,}/g, ' ').trim();
}
