import type { ClipWord } from '../clipping/types';
import type { RecipeId } from '../hunter/types';

/**
 * Compilations: several moments (hunted from streams, or clips made from links) put together as
 * one video, either a Short (9:16, under a minute) or a long-form countdown (16:9, numbered, with
 * voiceover cards between clips). One folder per compilation, nothing in the database.
 */

export type CompilationFormat = 'short' | 'long';

/** One moment or clip that can go into a compilation. */
export interface LibraryItem {
  /** "hunt:<huntId>:<momentId>" or "clip:<clipId>". */
  key: string;
  kind: 'moment' | 'clip';
  title: string;
  /** What happens, in a sentence. */
  description: string;
  recipe: RecipeId;
  /** 1-10; clips made from links have none (treated as 6 when picking). */
  score: number | null;
  /** Who to credit (an @handle or name). */
  creator: string;
  platform: string;
  /** Link to the moment on its site (with a timestamp where the site supports it). */
  pageUrl: string;
  /** Absolute path of the video file. */
  file: string;
  /** The part of the file to use, in seconds. */
  start: number;
  end: number;
  /** A still to show (absolute path), if there is one. */
  thumb: string | null;
  transcript: string;
  createdAt: string;
  /** Compilations already using it. */
  usedIn: string[];
}

export interface CompilationItem {
  key: string;
  /** The part of the file used (seconds into the file). */
  start: number;
  end: number;
  /** Short name on the number card ("The bike bail"). */
  label: string;
  /** Voiceover line before the clip (long form). */
  line: string;
  /** Copied from the library when added, so the compilation still renders if a hunt is deleted. */
  file: string;
  creator: string;
  pageUrl: string;
  title: string;
  description: string;
  recipe: RecipeId;
  score: number | null;
}

export interface ItemAnalysis {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** The loudest moment, seconds into the file. */
  peakSec: number | null;
  /** Dialogue words, seconds into the file. */
  words: ClipWord[];
}

export interface Compilation {
  id: string;
  format: CompilationFormat;
  title: string;
  /** What ties the clips together ("Funniest moments this week"). */
  theme: string;
  items: CompilationItem[];
  /** On-screen hook for the first seconds (Shorts). */
  hook: string;
  /** Voiceover for the opening and closing cards (long form). */
  intro: string;
  outro: string;
  titles: string[];
  description: string;
  tags: string[];
  options: {
    captions: boolean;
    cleanCaptions: boolean;
    nameCards: boolean;
    voiceover: boolean;
    /** Fill the frame with the middle of each clip (Shorts); otherwise the whole picture over a blurred copy. */
    crop: boolean;
    voice: string;
  };
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'queued' | 'analyzing' | 'writing' | 'voicing' | 'rendering' | 'ready' | 'failed';
  step: string;
  progress?: number;
  error?: string;
  warnings: string[];
  /** Per-item analysis, by item key (kept so re-renders are quick). */
  analysis: Record<string, ItemAnalysis>;
  /** Voiced lines: intro, outro and each item's line, by "intro" | "outro" | item key. */
  voice: Record<string, { text: string; file: string; durationSec: number; key: string }>;
  output?: { video: string; thumbnail: string; durationSec: number; renderedAt: string };
}

/** Shorts stay under a minute. */
export const SHORT_MAX_SEC = 58;
