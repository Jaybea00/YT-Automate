import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Bible verses for verse cards. The words always come from the World English Bible (public
 * domain), fetched by reference from bible-api.com and cached, never from a model's memory.
 * "webbe" is the WEB British Edition, which writes "the LORD"; "web" writes the divine name as
 * "Yahweh".
 */

export type BibleTranslation = 'webbe' | 'web';
export const DEFAULT_TRANSLATION: BibleTranslation = 'webbe';
export const TRANSLATION_LABELS: Record<BibleTranslation, string> = { webbe: 'WEB', web: 'WEB' };

/** A verse card shows at most this many verses; longer passages are told, not shown. */
export const MAX_CARD_VERSES = 3;

/** The 66 books with the short forms people write. */
const BOOKS: Array<[string, string[]]> = [
  ['Genesis', ['gen', 'gn']], ['Exodus', ['exod', 'exo', 'ex']], ['Leviticus', ['lev', 'lv']], ['Numbers', ['num', 'nm']],
  ['Deuteronomy', ['deut', 'dt']], ['Joshua', ['josh', 'jos']], ['Judges', ['judg', 'jdg']], ['Ruth', ['ru']],
  ['1 Samuel', ['1 sam', '1sam', 'i samuel']], ['2 Samuel', ['2 sam', '2sam', 'ii samuel']], ['1 Kings', ['1 kgs', '1kgs', 'i kings']],
  ['2 Kings', ['2 kgs', '2kgs', 'ii kings']], ['1 Chronicles', ['1 chr', '1chr']], ['2 Chronicles', ['2 chr', '2chr']],
  ['Ezra', ['ezr']], ['Nehemiah', ['neh']], ['Esther', ['esth', 'est']], ['Job', ['jb']], ['Psalms', ['psalm', 'ps', 'psa']],
  ['Proverbs', ['prov', 'prv']], ['Ecclesiastes', ['eccl', 'ecc']], ['Song of Solomon', ['song of songs', 'song', 'sos']],
  ['Isaiah', ['isa']], ['Jeremiah', ['jer']], ['Lamentations', ['lam']], ['Ezekiel', ['ezek', 'eze']], ['Daniel', ['dan', 'dn']],
  ['Hosea', ['hos']], ['Joel', ['jl']], ['Amos', ['am']], ['Obadiah', ['obad', 'ob']], ['Jonah', ['jon']], ['Micah', ['mic']],
  ['Nahum', ['nah']], ['Habakkuk', ['hab']], ['Zephaniah', ['zeph']], ['Haggai', ['hag']], ['Zechariah', ['zech']], ['Malachi', ['mal']],
  ['Matthew', ['matt', 'mt']], ['Mark', ['mk', 'mrk']], ['Luke', ['lk']], ['John', ['jn', 'jhn']], ['Acts', ['act']],
  ['Romans', ['rom']], ['1 Corinthians', ['1 cor', '1cor']], ['2 Corinthians', ['2 cor', '2cor']], ['Galatians', ['gal']],
  ['Ephesians', ['eph']], ['Philippians', ['phil', 'php']], ['Colossians', ['col']], ['1 Thessalonians', ['1 thess', '1thess']],
  ['2 Thessalonians', ['2 thess', '2thess']], ['1 Timothy', ['1 tim', '1tim']], ['2 Timothy', ['2 tim', '2tim']], ['Titus', ['tit']],
  ['Philemon', ['phlm', 'philem']], ['Hebrews', ['heb']], ['James', ['jas']], ['1 Peter', ['1 pet', '1pet']], ['2 Peter', ['2 pet', '2pet']],
  ['1 John', ['1 jn', '1jn']], ['2 John', ['2 jn', '2jn']], ['3 John', ['3 jn', '3jn']], ['Jude', ['jud']], ['Revelation', ['rev', 'revelations']],
];

const BOOK_BY_NAME = new Map<string, string>();
for (const [name, short] of BOOKS) {
  for (const key of [name, ...short]) BOOK_BY_NAME.set(key.toLowerCase().replace(/\./g, ''), name);
}

export interface VerseRef {
  book: string;
  chapter: number;
  from: number;
  to: number;
}

/** "Exodus 14:21", "Ex. 14:21-22", "1 John 4:8" -> a reference, or null if it isn't one. */
export function parseVerseRef(text: string): VerseRef | null {
  const m = text.trim().match(/^(.+?)\.?\s+(\d{1,3})\s*:\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?$/);
  if (!m) return null;
  const book = BOOK_BY_NAME.get(m[1].toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim());
  if (!book) return null;
  const chapter = Number(m[2]);
  const from = Number(m[3]);
  const to = m[4] ? Number(m[4]) : from;
  if (chapter < 1 || from < 1 || to < from) return null;
  return { book, chapter, from, to };
}

export function formatVerseRef(ref: VerseRef): string {
  return `${ref.book} ${ref.chapter}:${ref.from}${ref.to > ref.from ? `-${ref.to}` : ''}`;
}

export interface VersePassage {
  reference: string;
  text: string;
  translation: BibleTranslation;
}

const cacheDir = () => process.env.BIBLE_CACHE_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'data-cache', 'bible');

/**
 * The verse words from the World English Bible, or null when the reference doesn't exist or the
 * service can't be reached (the card then shows no scripture rather than unchecked words).
 * Passages longer than MAX_CARD_VERSES are cut to their first verses.
 */
export async function fetchVerses(
  reference: string,
  translation: BibleTranslation = DEFAULT_TRANSLATION,
  fetcher: typeof fetch = fetch,
): Promise<VersePassage | null> {
  const ref = parseVerseRef(reference);
  if (!ref) return null;
  const card = { ...ref, to: Math.min(ref.to, ref.from + MAX_CARD_VERSES - 1) };
  const label = formatVerseRef(card);
  const file = path.join(/* turbopackIgnore: true */ cacheDir(), translation, `${label.replace(/[^a-z0-9]+/gi, '_')}.json`);
  const cached = await fs.readFile(file, 'utf-8').then((s) => JSON.parse(s) as VersePassage).catch(() => null);
  if (cached?.text) return cached;
  try {
    const url = `https://bible-api.com/${encodeURIComponent(label)}?translation=${translation}`;
    const res = await fetcher(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { verses?: Array<{ text?: string }> };
    const text = (data.verses ?? []).map((v) => (v.text ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
    if (!text) return null;
    const passage: VersePassage = { reference: label, text, translation };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(passage), 'utf-8');
    return passage;
  } catch {
    return null;
  }
}
