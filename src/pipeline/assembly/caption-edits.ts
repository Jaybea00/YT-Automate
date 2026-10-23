import type { WordTiming } from '../tts/word-timings';

/**
 * The creator's caption edits, per beat, made in Vibedit's caption editor. They apply to the
 * beat's caption words (the narrator's timed words, or the text spread evenly), by position:
 *  - fixes: a word shown differently (a name spelled right, "1929" for "nineteen twenty-nine");
 *    an empty fix drops the word from the captions
 *  - breaks: words that start a new caption line
 *  - emphasis: words always shown in the accent colour
 *  - hidden: no burned-in captions for the beat (subtitle files keep them)
 * `basis` is the word list the positions refer to; if the beat's words change (re-voiced or
 * rewritten), the edits no longer line up and are set aside rather than misapplied.
 */
export interface CaptionEdit {
  basis: string[];
  fixes?: Record<number, string>;
  breaks?: number[];
  emphasis?: number[];
  hidden?: boolean;
}

export type CaptionEdits = Record<number, CaptionEdit>;

/** A caption word with the editor's marks. */
export interface EditedWord extends WordTiming {
  breakBefore?: boolean;
  emphasis?: boolean;
}

// Braces and backslashes are ASS override syntax; markdown marks never show
export const cleanCaptionWord = (w: string) => w.replace(/[*_#`{}\\]/g, '').trim();

/**
 * A beat's caption words, timed from the beat's voice start (seconds): the narrator's timings
 * when there are any, the text spread evenly over `durationSec` otherwise.
 */
export function baseCaptionWords(text: string, timed: WordTiming[] | undefined, durationSec: number): WordTiming[] {
  if (timed?.length) return timed.map((w) => ({ ...w, word: cleanCaptionWord(w.word) })).filter((w) => w.word);
  const words = text.split(/\s+/).map(cleanCaptionWord).filter(Boolean);
  const step = durationSec / Math.max(1, words.length);
  return words.map((word, i) => ({ word, start: i * step, end: (i + 1) * step }));
}

/** Whether an edit still lines up with the beat's words. */
export function editMatches(edit: CaptionEdit | undefined, words: WordTiming[]): edit is CaptionEdit {
  return Boolean(edit) && edit!.basis.length === words.length && edit!.basis.every((w, i) => w === words[i].word);
}

/**
 * The caption words for every beat with the edits applied. Beats without edits keep the words
 * they had (so captions are unchanged); an edited beat gets explicit words. A hidden beat gets an
 * empty list (no captions) unless `forFiles` (subtitle files keep every line).
 */
export function applyCaptionEdits(
  beats: Array<{ index: number; text: string; durationSec: number }>,
  words: Record<number, WordTiming[]>,
  edits: CaptionEdits | null | undefined,
  options: { forFiles?: boolean } = {},
): Record<number, EditedWord[]> {
  const out: Record<number, EditedWord[]> = { ...words };
  if (!edits) return out;
  for (const beat of beats) {
    const edit = edits[beat.index];
    if (!edit) continue;
    const base = baseCaptionWords(beat.text, words[beat.index], beat.durationSec);
    if (!editMatches(edit, base)) continue;
    if (edit.hidden && !options.forFiles) {
      out[beat.index] = [];
      continue;
    }
    const breaks = new Set(edit.breaks ?? []);
    const emphasis = new Set(edit.emphasis ?? []);
    const edited: EditedWord[] = [];
    let pendingBreak = false;
    base.forEach((w, i) => {
      const fix = edit.fixes?.[i];
      const word = fix === undefined ? w.word : cleanCaptionWord(fix);
      if (breaks.has(i)) pendingBreak = true;
      if (!word) return;
      edited.push({
        ...w,
        word,
        ...(!options.forFiles && pendingBreak && edited.length ? { breakBefore: true } : {}),
        ...(!options.forFiles && emphasis.has(i) ? { emphasis: true } : {}),
      });
      pendingBreak = false;
    });
    out[beat.index] = edited;
  }
  return out;
}

/** Keeps a submitted edit sane: positions inside the basis, short fixes, sorted unique lists. */
export function normalizeCaptionEdit(raw: unknown): CaptionEdit | null {
  const r = raw as Partial<CaptionEdit> | null;
  if (!r || !Array.isArray(r.basis) || !r.basis.every((w) => typeof w === 'string')) return null;
  const n = r.basis.length;
  const inRange = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < n;
  const list = (xs: unknown) => (Array.isArray(xs) ? [...new Set(xs.filter(inRange))].sort((a, b) => a - b) : []);
  const fixes: Record<number, string> = {};
  for (const [k, v] of Object.entries(r.fixes ?? {})) {
    const i = Number(k);
    if (inRange(i) && typeof v === 'string' && cleanCaptionWord(v) !== r.basis[i]) fixes[i] = v.slice(0, 40);
  }
  const edit: CaptionEdit = { basis: r.basis.slice(0, 400) };
  if (Object.keys(fixes).length) edit.fixes = fixes;
  const breaks = list(r.breaks).filter((i) => i > 0);
  if (breaks.length) edit.breaks = breaks;
  const emphasis = list(r.emphasis);
  if (emphasis.length) edit.emphasis = emphasis;
  if (r.hidden === true) edit.hidden = true;
  return edit;
}

/** True when an edit changes nothing (so it can be removed). */
export const isEmptyEdit = (e: CaptionEdit) => !e.fixes && !e.breaks && !e.emphasis && !e.hidden;
