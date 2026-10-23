/** Pronunciation hint types, safe to use in the browser. */

export interface PronunciationHint {
  /** The word as written in the script. */
  term: string;
  /** Suggested respelling, e.g. "chah-BREE-noh-vich". */
  say: string;
  /** What it is, e.g. "Serbian surname". */
  note?: string;
  /** Unticked by the creator: not added to the pronunciation list. */
  skip?: boolean;
  /** Already added to the channel's pronunciation list. */
  added?: boolean;
}

export interface PronunciationHints {
  checkedAt: string;
  hints: PronunciationHint[];
}
