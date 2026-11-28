/**
 * Guide Shorts ("5 crazy things you can do in GTA 6"): a narrator talks over the user's own
 * gameplay, one numbered item at a time, cutting every second or two, and the end flows back into
 * the start so the Short loops. Everything about one guide lives in one folder (see store.ts):
 * guide.json, the recordings under footage/, the voice under voice/, the Short under export/.
 *
 * In the spoken text, *words* are shown in green in the captions and ~words~ in red; the marks are
 * not read out.
 */

/** A stretch of one recording. */
export interface GuideShot {
  /** File inside the guide folder (normally footage/<name>). */
  file: string;
  /** Seconds into the recording. */
  from: number;
  to: number;
  /** Where the vertical crop is centred across the picture (0 left – 1 right; the middle when missing). */
  focusX?: number;
  /** Punch in on part of the picture (2 = twice as close; a phone screen in the player's hand). */
  zoom?: number;
  /** With a zoom: where the crop is centred down the picture (0 top – 1 bottom; the middle when missing). */
  focusY?: number;
  /** Play this shot as one cut of exactly this many seconds (to line up with a graphic); the other shots share what's left. */
  sec?: number;
  /** A slow push in across the cut (0.15 = 15% closer by its end). With a tiny from–to stretch and a `sec`, it's a freeze-frame. */
  push?: number;
  /** A sound from the library as the cut starts ("dark impact"). */
  sound?: string;
  /** Leave out this shot's own sound (a streamer talking over the game). */
  mute?: boolean;
  /** How loud this shot's own sound plays (0 – 1), instead of the guide's gameVolume (a podcast or a line of dialogue the viewer should hear). */
  volume?: number;
  /** Wide videos: play another shot beside this one, side by side (then | now); this shot is the left half. */
  beside?: GuideShot;
  /** With `beside`: a tag over each half ("2002", "GTA 6"). */
  labels?: [string, string];
}

/** A motion graphic from gta-components (see motion.ts) over part of an item. */
export interface GuideMotion {
  kind: 'wasted' | 'location' | 'social';
  /** Seconds into the item; negative counts back from the item's end (-2.2: the last 2.2 s). */
  at: number;
  /** How long it shows (each kind has its own length when missing). */
  durationSec?: number;
  variant?: string;
  /** Draw the component's own background over the footage (a social post on a blurred copy of its clip). */
  plate?: boolean;
  /** Changes to the component's CONFIG: its words, numbers and timing. */
  config?: Record<string, unknown>;
  /** social: the clip that plays inside the post (cut and framed like any shot). */
  clip?: GuideShot;
}

/** One numbered thing ("1. Throw dog poop"); in a wide video, one paragraph of the script. */
export interface GuideItem {
  /** The card at the top while the item starts ("THROW DOG POOP"); the number is added. Empty: no card and no whoosh (a paragraph that carries on a chapter). */
  heading: string;
  /** Under the heading: a typed emoji or an emoji-library name. */
  emoji?: string;
  /** What the narrator says ("Number one, you can throw *dog poop* at people."). */
  say: string;
  /** The footage for this item, in order. */
  shots: GuideShot[];
  /** Extra seconds after the line (room for a WASTED to land, or for the game's own audio to be heard). */
  after?: number;
  /** Wide videos: a tag that slides in at the top left as the item starts, saying where this is ("📍 KEY LENTO · JASON'S HOUSE"). */
  note?: string;
  /** Wide videos: this item's name in the description's chapter list (its heading when missing; false: no chapter here). */
  chapter?: string | false;
  motion?: GuideMotion[];
}

/** A spoken part of the guide, once voiced. */
export interface GuideVoice {
  /** Which part: 'hook', 'item-0'…, 'outro', 'loop'. */
  part: string;
  /** The text as spoken (marks removed). */
  text: string;
  audioFile?: string;
  audioKey?: string;
  durationSec?: number;
  words?: Array<{ word: string; start: number; end: number }>;
}

export interface GuideProject {
  id: string;
  /** 'short' (9:16, the default) or 'wide' (16:9, a long video for the main feed: still pictures and side-by-side shots work, motion graphics don't). */
  format?: 'short' | 'wide';
  /** Silence after each spoken part (seconds; 0.12 when missing). Long videos breathe more. */
  gapSec?: number;
  /** Seconds of footage and music after the last line, with no voice (room for YouTube's end screen). */
  tailSec?: number;
  /** Wide videos: the name of the first chapter in the description's chapter list ("Intro" when missing). */
  introChapter?: string;
  /** A ready-made thumbnail (file inside the guide folder) to use instead of a frame from the video. */
  thumbnail?: string;
  createdAt: string;
  updatedAt: string;
  /** The YouTube title ("5 CRAZY THINGS In GTA 6 That You CAN'T Do In GTA 5"). */
  title: string;
  /** The big text over the opening shot, under the logo ("5 *CRAZY* THINGS YOU CAN DO"). */
  titleCard: string;
  /** Seconds the title shows over the opening shot (the whole hook when missing); the hook is captioned after it. */
  titleSec?: number;
  /** A logo picture shown above the title card (file inside the guide folder, or storage/guide/logo.png when missing). */
  logo?: string;
  /** The first line, spoken over the opening shot ("Here's five *crazy* things you can do in GTA 6…"). */
  hook: string;
  /** The opening shot: the most eye-catching moment of the guide. The Short loops back into it. */
  opener: GuideShot;
  /** More footage for the hook when it runs longer than the opener. */
  hookShots?: GuideShot[];
  items: GuideItem[];
  /** The question for the comments ("So which one are you going to try first?"). */
  outro: string;
  /** Footage under the outro; when missing, the footage just before the opener (so the loop is seamless). */
  outroShots?: GuideShot[];
  /** The last words, which run into the hook when the Short replays. */
  loopLine: string;
  /** Number the item cards (1. 2. 3.…). */
  numbered: boolean;
  /** TTS voice id; empty uses the channel's voice (with ElevenLabs: an ElevenLabs voice id). */
  voice: string;
  /**
   * Who voices it: the channel's narration voice (Kokoro, normally; the default), or ElevenLabs
   * (ELEVENLABS_API_KEY), which acts out [tags] in the text ("[whispers] He's right.").
   */
  voiceEngine?: 'channel' | 'elevenlabs';
  /** ElevenLabs model (eleven_v3 when missing: the one that follows [tags]). */
  voiceModel?: string;
  /** Speaking speed (1 is normal; guides read fast). */
  speed: number;
  /** Seconds per cut, on average. */
  cutSec: number;
  /** How loud the game's own sound stays under the narrator (0 – 1). */
  gameVolume: number;
  /** A music bed under the whole Short: a file inside the guide folder (or none). It's levelled, then ducks under the narrator; musicVolume (1 = as levelled) sets how loud it sits. */
  music?: string;
  musicVolume?: number;
  /** Where in the track the music starts (seconds). */
  musicFrom?: number;
  /** A whoosh as each item starts. */
  whooshes: boolean;
  /** Punchier colour. */
  grade: boolean;
  description: string;
  tags: string[];
  voiced?: GuideVoice[];
  warnings?: string[];
  output?: { video: string; thumbnail: string; renderedAt: string; durationSec: number };
}

/** A recording's size and whether it has sound. */
export interface FootageInfo {
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
  /** The picture inside black bars a recording was posted with (missing when there are none). */
  box?: { x: number; y: number; w: number; h: number };
}
