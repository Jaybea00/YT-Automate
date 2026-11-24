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
  /** Set by the reaction timeline: seconds the line waits after its moment (a freeze's record scratch plays first). */
  offsetSec?: number;
}

/** Short on-screen text ("wait for it…"), seconds from the start of the source clip. */
export interface TextOverlay {
  at: number;
  until: number;
  text: string;
}

/** classic: hook banner and captions over the clip; reaction: header box, memes, freezes, replays and hits. */
export type EditStyle = 'classic' | 'reaction';

/** The white box above the clip that tells the story from the first frame ("NPCs have ZERO chill 😭"). */
export interface HeaderBox {
  /** May end in emoji: the box is drawn by a browser, so they show in colour. */
  text: string;
  /** Words shown in red. */
  highlight: string[];
}

/** A meme clip found for a cut-in, normalised into the clip folder. */
export interface MemeFile {
  /** File name inside the clip folder. */
  file: string;
  source: 'library' | 'klipy' | 'giphy' | 'tenor';
  title: string;
  /** Where it came from (a GIPHY/Tenor page or the library file name). */
  origin: string;
  hasAudio: boolean;
  durationSec: number;
  /** The query and pick it was found for: a different one fetches again. */
  key: string;
}

/** A sound effect found for a moment (vine boom, bruh, sad violin…), normalised into the clip folder. */
export interface SoundFile {
  /** File name inside the clip folder. */
  file: string;
  source: 'library' | 'builtin';
  title: string;
  origin: string;
  durationSec: number;
  /** The query it was found for: a different one fetches again. */
  key: string;
}

/** A point on the source picture, as fractions of its width and height (0-1). */
export interface FramePoint {
  x: number;
  y: number;
}

/**
 * meme, freeze and replay play between two moments of the clip; a ramp slows the stretch of clip
 * just before `at` (replaySec long) to half speed, building up to the hit; a teaser (the cold open)
 * plays the stretch just before `at` (replaySec long) first of all, then rewinds into the start.
 */
export type CutInKind = 'meme' | 'freeze' | 'replay' | 'ramp' | 'skull' | 'skip' | 'teaser';

/**
 * Something that plays *between* two moments of the clip: the clip stops at `at`, the cut-in plays,
 * then the clip carries on. Nothing of the clip is hidden.
 */
export interface CutIn {
  kind: CutInKind;
  /** Seconds into the source clip. */
  at: number;
  /** Seconds the cut-in lasts (a freeze stretches to fit a voice line at the same point). */
  durationSec: number;
  /** meme: what to search for ("it's working", "shocked guy"). */
  query?: string;
  /** meme: which search result to use; "Try another" moves it on. */
  pick?: number;
  meme?: MemeFile;
  /** replay: seconds of clip before `at` shown again in slow motion; ramp: seconds before `at` slowed down; teaser: seconds before `at` shown first. */
  replaySec?: number;
  /** freeze: a red circle and arrow on this spot ("look at the guy on the left"). */
  focus?: FramePoint;
  /** skull: the picture (a typed emoji or an emoji-library name); 💀 when missing. */
  emoji?: string;
  /** skip: seconds of clip cut out from `at` (a slow stretch), jumped over with a whip. */
  skipSec?: number;
}

/** A hit on a moment of the clip (seconds into the source clip). */
export interface ClipEffect {
  at: number;
  /** flash: red pulse; shake: camera jolt + thud; emoji: pops up and floats away; sound: a meme sound; comic: black-and-white comic-dot flash. */
  kind: 'flash' | 'shake' | 'emoji' | 'sound' | 'comic';
  /** emoji: which one (💀, 😭…). */
  emoji?: string;
  /** sound: what to look for ("vine boom", "bruh", "sad violin"). */
  query?: string;
  sound?: SoundFile;
}

export type EndingStyle = 'none' | 'tbc' | 'credits' | 'stamp' | 'skull' | 'recap';

/**
 * How the Short ends. tbc: the last frame freezes in sepia and an arrow banner slides in; credits:
 * cut to black with credit lines; stamp: black-and-white freeze with a red rubber stamp; skull: grey,
 * dark freeze with a big skull on a bass hit; recap: a burst of quick cuts of the best moments,
 * landing on the big one. Each with its sound (from the sound library, or a built-in one).
 */
export interface Ending {
  style: EndingStyle;
  /** The banner, stamp or credit text ("TO BE CONTINUED", "SKILL ISSUE", "Directed by\nJASON"). */
  text: string;
  /** skull: the picture (a typed emoji or an emoji-library name). */
  emoji?: string;
  query?: string;
  sound?: SoundFile;
  durationSec: number;
}

export interface ClipPlan {
  /** Missing on clips made before reaction edits: classic. */
  editStyle?: EditStyle;
  header?: HeaderBox;
  cutIns?: CutIn[];
  effects?: ClipEffect[];
  /** Where the zoom punch on the big moment aims (the centre when missing). */
  zoomFocus?: FramePoint;
  ending?: Ending;
  /** Ends by blending into the first frame (no fade to black), so a replay feels seamless. Ignored under an ending. */
  loop?: boolean;
  /** A quick motion blur into and out of every cut-in and the ending (on unless false). */
  whipBlur?: boolean;
  /** Punchier colour for the whole Short: contrast, saturation, sharpening, dark edges. */
  grade?: boolean;
  /** The spoken word in the captions glows, in a colour that changes each line. */
  glowCaptions?: boolean;
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
  /** The source file was put in the folder directly (a hunted moment), so there is nothing to download. */
  localSource?: boolean;
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
