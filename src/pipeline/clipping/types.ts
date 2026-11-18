/**
 * Clip-to-Short projects: a clip link goes in, a finished vertical Short and its upload details
 * come out. Everything about one clip lives in one folder (see store.ts), nothing in the database.
 */

export type ClipStatus =
  | 'queued'
  | 'downloading'
  | 'analyzing'
  | 'writing'
  | 'voicing'
  | 'rendering'
  | 'ready'
  | 'failed';

/** fit: whole picture over a blurred copy; crop: full-screen centre crop; original: already vertical. */
export type ClipLayout = 'fit' | 'crop' | 'original';

export type VoiceStyle = 'narrator' | 'hype' | 'info';

/** A word with its time in seconds from the start of the source clip. */
export interface ClipWord {
  word: string;
  start: number;
  end: number;
}

export interface VoiceLine {
  /** Seconds from the start of the source clip. */
  at: number;
  text: string;
  slot: 'hook' | 'build' | 'after' | 'other';
  /** Rendered voice (file name inside the clip folder) and what it was rendered from. */
  audioFile?: string;
  audioKey?: string;
  durationSec?: number;
  /** Word timings inside the line's audio (seconds from the line's start). */
  words?: ClipWord[];
}

/** Short on-screen text ("wait for it…"), seconds from the start of the source clip. */
export interface TextOverlay {
  at: number;
  until: number;
  text: string;
}

export interface ClipPlan {
  hook: string;
  /** Seconds the hook stays on screen (from the start of the Short). */
  hookSec: number;
  overlays: TextOverlay[];
  voiceLines: VoiceLine[];
  titles: string[];
  description: string;
  tags: string[];
  /** The big moment, seconds from the start of the source clip. */
  peakSec: number | null;
  layout: ClipLayout;
  /** The part of the source used, in seconds. */
  trimStart: number;
  trimEnd: number;
  captions: boolean;
  /** Swear words in captions shown as f***. The sound is unchanged. */
  cleanCaptions: boolean;
  showHook: boolean;
  voiceover: boolean;
  muteMusic: boolean;
  zoomOnPeak: boolean;
  sfxOnPeak: boolean;
  voiceStyle: VoiceStyle;
  /** TTS voice id; empty uses the narration stage's default voice. */
  voice: string;
}

export interface ClipAnalysis {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Loudness every LOUDNESS_STEP seconds, in dB (silence is -90). */
  loudness: number[];
  /** Loud moments, strongest first. */
  peaks: Array<{ at: number; score: number }>;
  /** In-game dialogue, as Whisper heard it. */
  words: ClipWord[];
  transcript: string;
  /** Stretches Whisper marked as music (possible licensed radio songs). */
  musicSections: Array<{ start: number; end: number }>;
  /** Stills sent to the script writer (file names inside the clip folder). */
  frames: Array<{ at: number; file: string }>;
}

export interface ClipSource {
  title: string;
  /** The post's own text (an X post's words, a video description). */
  postText: string;
  uploader: string;
  uploaderHandle: string;
  platform: string;
  pageUrl: string;
  /** Downloaded file name inside the clip folder. */
  file: string;
}

export interface ClipProject {
  id: string;
  sourceUrl: string;
  /** Who made the clip, for the credit (an @handle or name). */
  creator: string;
  /** The user's one-line description of the moment, to steer the script. */
  note: string;
  createdAt: string;
  updatedAt: string;
  status: ClipStatus;
  /** What is happening right now, in words. */
  step: string;
  error?: string;
  warnings: string[];
  source?: ClipSource;
  analysis?: ClipAnalysis;
  plan?: ClipPlan;
  output?: { video: string; thumbnail: string; renderedAt: string; durationSec: number };
}

/** Seconds between loudness readings. */
export const LOUDNESS_STEP = 0.5;
/** Shorts stay under a minute unless the user trims longer on purpose. */
export const DEFAULT_MAX_SHORT_SEC = 59;
/** Roughly how fast a narrator speaks, used to fit a line into a gap. */
export const WORDS_PER_SEC = 2.5;
