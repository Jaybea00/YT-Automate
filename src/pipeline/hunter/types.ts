/**
 * Stream hunts: a finished stream (VOD) goes in, its best moments come out as short clips, each
 * labelled with a recipe (funny, chase, crash…). Any moment can then be sent to the clip editor
 * (src/pipeline/clipping) to become a Short. One folder per hunt, nothing in the database.
 */

export type HuntStatus = 'queued' | 'probing' | 'listening' | 'scanning' | 'judging' | 'cutting' | 'ready' | 'failed';

export type RecipeId = 'funny' | 'chase' | 'crash' | 'clutch' | 'rage' | 'glitch' | 'other';

/** A chat message or a caption line, seconds from the start of the stream. */
export interface TimedText {
  t: number;
  text: string;
}

/** A stretch the signals flagged, before the judge has looked at it. */
export interface Candidate {
  /** The loudest / busiest second. */
  at: number;
  start: number;
  end: number;
  score: number;
  recipeGuess: RecipeId;
  chatCount: number;
}

export interface Moment {
  id: string;
  start: number;
  end: number;
  recipe: RecipeId;
  /** The judge's score, 1-10. */
  score: number;
  reason: string;
  /** A suggested hook for the Short. */
  hook: string;
  transcript: string;
  chatSample: string[];
  status: 'found' | 'cut' | 'failed';
  /** The cut clip and its still (file names inside the hunt folder). */
  file?: string;
  thumb?: string;
  error?: string;
  /** The clip project made from this moment. */
  clipId?: string;
  discarded?: boolean;
}

export interface Hunt {
  id: string;
  url: string;
  platform: string;
  title: string;
  uploader: string;
  uploaderHandle: string;
  pageUrl: string;
  durationSec: number;
  /** Credit for every clip from this stream (defaults to the uploader). */
  creator: string;
  /** Most moments to keep. */
  maxMoments: number;
  createdAt: string;
  updatedAt: string;
  status: HuntStatus;
  step: string;
  /** 0-100 within the current step, when known. */
  progress?: number;
  error?: string;
  warnings: string[];
  /** What the hunt had to go on. */
  signals: { chat: number; captions: boolean; audio: boolean; uploadedChat: boolean };
  candidates: Candidate[];
  moments: Moment[];
}

/** Seconds kept before and after the flagged second (reactions come after the event). */
export const WINDOW_BEFORE = 25;
export const WINDOW_AFTER = 12;
/** Stretches flagged per hunt before the judge picks. */
export const MAX_CANDIDATES = 30;
