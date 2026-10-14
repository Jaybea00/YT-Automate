import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import type { BeatTimingLike, UnitDurationLike } from '../utils/subtitles';

const execFileAsync = promisify(execFile);

export type CaptionPreset = 'vox' | 'social_pop' | 'clean_news';

export const CAPTION_PRESETS: CaptionPreset[] = ['vox', 'social_pop', 'clean_news'];

export function isCaptionPreset(value: unknown): value is CaptionPreset {
  return CAPTION_PRESETS.includes(value as CaptionPreset);
}

/** Times where captions must make way for what's on screen. */
export interface CaptionZone {
  startMs: number;
  endMs: number;
  /** hide: full-screen text (the words are already on screen); raise: clear a lower-third. */
  kind: 'hide' | 'raise';
}

export interface GenerateCaptionsOptions {
  beats: BeatTimingLike[];
  units?: UnitDurationLike[];
  preset?: CaptionPreset;
  outputAssPath?: string;
  /**
   * Where each beat's voice starts in the final video (ms), aligned with `beats`.
   * When omitted, beats are laid back-to-back using their speech durations.
   */
  beatStartMs?: number[];
  /** The narrator's word timings per beat (seconds from the beat's voice start), by beat index. */
  words?: Record<number, Array<{ word: string; start: number; end: number }>>;
  /** The video's accent colour (#rrggbb) for the active word. */
  highlightHex?: string;
  /** Where captions hide (full-screen text) or rise (lower-thirds). */
  zones?: CaptionZone[];
  /** Canvas size (default 1920x1080; Shorts use 1080x1920). */
  resolution?: { width: number; height: number };
  /** Distance of captions from the bottom edge, overriding the preset's. */
  marginV?: number;
  /** Text size, overriding the preset's. */
  fontSize?: number;
  /** Lines shown for the whole video (e.g. a Short's hook banner), in ASS override syntax-free text. */
  banners?: Array<{ text: string; startMs: number; endMs: number; position: 'top' | 'bottom' }>;
}

export interface CaptionWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface CaptionDialogue {
  startMs: number;
  endMs: number;
  text: string;
  style: string;
}

/**
 * Formats milliseconds into ASS timecode: H:MM:SS.cc (centiseconds)
 */
export function formatAssTime(ms: number): string {
  const totalCs = Math.max(0, Math.floor(ms / 10));
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hours = Math.floor(totalMin / 60);

  const pad = (n: number, z = 2) => n.toString().padStart(z, '0');
  return `${hours}:${pad(min)}:${pad(sec)}.${pad(cs, 2)}`;
}

/** Per-preset look. Fonts are ones installed with Windows (libass falls back silently otherwise). */
interface PresetStyle {
  name: string;
  font: string;
  size: number;
  outline: number;
  shadow: number;
  /** 1: outline and shadow; 3: opaque box behind the text. */
  borderStyle: 1 | 3;
  back: string;
  marginV: number;
  maxWords: number;
  maxChars: number;
  /** Active word grows slightly, for presets made to pop. */
  popScale: number;
  uppercase: boolean;
  highlight: boolean;
}

const PRESET_STYLES: Record<CaptionPreset, PresetStyle> = {
  // A heavy outline and shadow keep white text readable on light graphics as well as footage
  vox: { name: 'VoxMinimal', font: 'Segoe UI Semibold', size: 58, outline: 4, shadow: 2, borderStyle: 1, back: '&H80000000', marginV: 70, maxWords: 6, maxChars: 38, popScale: 100, uppercase: false, highlight: true },
  social_pop: { name: 'SocialPop', font: 'Segoe UI Black', size: 74, outline: 5, shadow: 2, borderStyle: 1, back: '&H00000000', marginV: 150, maxWords: 3, maxChars: 22, popScale: 112, uppercase: true, highlight: true },
  clean_news: { name: 'CleanNews', font: 'Segoe UI', size: 46, outline: 10, shadow: 0, borderStyle: 3, back: '&H99000000', marginV: 60, maxWords: 8, maxChars: 48, popScale: 100, uppercase: false, highlight: false },
};

/** Default active-word colour (gold), in ASS's &HBBGGRR& order. */
const DEFAULT_HIGHLIGHT = '&H00D4FF&';
/** How far captions rise to clear a lower-third name caption. */
const RAISED_MARGIN_V = 330;
/** A phrase stays up this long after its last word unless the next one starts sooner. */
const PHRASE_HOLD_MS = 500;
/** A silence this long between words starts a new phrase. */
const PHRASE_GAP_MS = 350;

/** #rrggbb to ASS colour (&HBBGGRR&). */
export function toAssColour(hex: string): string {
  const m = hex.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? `&H${m[3]}${m[2]}${m[1]}&`.toUpperCase() : DEFAULT_HIGHLIGHT;
}

/** Splits timed words into caption phrases at sentence and clause ends, pauses, and length limits. */
export function groupPhrases(words: CaptionWord[], maxWords: number, maxChars: number): CaptionWord[][] {
  const phrases: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  const length = (ws: CaptionWord[]) => ws.reduce((n, w) => n + w.word.length + 1, -1);
  for (const [i, w] of words.entries()) {
    const prev = words[i - 1];
    const breakBefore =
      current.length > 0 &&
      (current.length >= maxWords ||
        length([...current, w]) > maxChars ||
        (prev !== undefined && w.startMs - prev.endMs > PHRASE_GAP_MS) ||
        /[.?!;:…]["”’']?$/.test(prev?.word ?? '') ||
        (/[,—–]["”’']?$/.test(prev?.word ?? '') && current.length >= 3));
    if (breakBefore) {
      phrases.push(current);
      current = [];
    }
    current.push(w);
  }
  if (current.length) phrases.push(current);

  // A lone word left over by the length limit joins the phrase before it when it fits nearly
  // as well, rather than flashing up on its own
  for (let i = phrases.length - 1; i > 0; i--) {
    const [only] = phrases[i];
    const before = phrases[i - 1];
    const last = before[before.length - 1];
    const continuous = only.startMs - last.endMs <= PHRASE_GAP_MS && !/[.?!;:…,—–]["”’']?$/.test(last.word);
    if (phrases[i].length === 1 && continuous && length([...before, only]) <= maxChars + 8) {
      before.push(only);
      phrases.splice(i, 1);
    }
  }
  return phrases;
}

function evenlyTimed(text: string, startMs: number, durationMs: number): CaptionWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  const step = durationMs / Math.max(1, words.length);
  return words.map((word, i) => ({ word, startMs: startMs + i * step, endMs: startMs + (i + 1) * step }));
}

// Braces and backslashes are ASS override syntax; strip them so narration can't inject tags
const cleanWord = (w: string) => w.replace(/[*_#`{}\\]/g, '').trim();

/**
 * Builds kinetic ASS captions: phrases timed to the narrator's actual words (from the voicing
 * stage's word timings, or spread evenly when a beat has none), the word being spoken
 * highlighted in the video's accent colour, hidden while full-screen text is showing and raised
 * above lower-third name captions.
 */
export function generateAssCaptions(options: GenerateCaptionsOptions): {
  assContent: string;
  dialogues: CaptionDialogue[];
} {
  const { beats, units = [], preset = 'vox', beatStartMs, words: timedWords = {}, zones = [] } = options;
  const look = PRESET_STYLES[preset] ?? PRESET_STYLES.vox;
  const highlightColour = options.highlightHex ? toAssColour(options.highlightHex) : DEFAULT_HIGHLIGHT;
  const { width = 1920, height = 1080 } = options.resolution ?? {};
  const size = options.fontSize ?? look.size;
  const styleLine = (name: string, marginV: number, alignment = 2, fontSize = size) =>
    `Style: ${name}, ${look.font}, ${fontSize}, &H00FFFFFF, &H00FFFFFF, &H00101010, ${look.back}, 0, 0, 0, 0, 100, 100, 0, 0, ${look.borderStyle}, ${look.outline}, ${look.shadow}, ${alignment}, 60, 60, ${marginV}, 1`;
  const banners = options.banners ?? [];

  const header = `[Script Info]
Title: YT-Automation Kinetic Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine(look.name, options.marginV ?? look.marginV)}
${styleLine(`${look.name}Raised`, RAISED_MARGIN_V)}
${banners.length ? `${styleLine('Banner', Math.round(height * 0.08), 8, Math.round(size * 1.05))}\n` : ''}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Every word of the video on one timeline
  const allWords: CaptionWord[] = [];
  let cursorMs = 0;
  for (const [pos, beat] of beats.entries()) {
    if (beatStartMs?.[pos] != null) cursorMs = beatStartMs[pos];
    const unit = units.find((u) => u.unit_index === beat.index && u.duration_ms != null && u.duration_ms > 0);
    const durationMs = unit?.duration_ms ?? Math.round((beat.duration_estimate_seconds ?? 4) * 1000);
    const timed = timedWords[beat.index];
    const beatWords = timed?.length
      ? timed.map((w) => ({ word: cleanWord(w.word), startMs: cursorMs + w.start * 1000, endMs: cursorMs + w.end * 1000 }))
      : evenlyTimed(cleanWord(beat.text || '').replace(/\s+/g, ' '), cursorMs, durationMs).map((w) => ({ ...w, word: cleanWord(w.word) }));
    allWords.push(...beatWords.filter((w) => w.word));
    cursorMs += durationMs;
  }

  const inZone = (startMs: number, endMs: number, kind: CaptionZone['kind']) =>
    zones.some((z) => z.kind === kind && Math.min(endMs, z.endMs) - Math.max(startMs, z.startMs) > (endMs - startMs) / 2);

  const dialogues: CaptionDialogue[] = [];
  const phrases = groupPhrases(allWords, look.maxWords, look.maxChars);
  for (const [p, phrase] of phrases.entries()) {
    const phraseStart = phrase[0].startMs;
    const nextStart = phrases[p + 1]?.[0].startMs ?? Infinity;
    const phraseEnd = Math.min(nextStart, phrase[phrase.length - 1].endMs + PHRASE_HOLD_MS);
    if (inZone(phraseStart, phraseEnd, 'hide')) continue;
    const style = inZone(phraseStart, phraseEnd, 'raise') ? `${look.name}Raised` : look.name;
    const shown = phrase.map((w) => (look.uppercase ? w.word.toUpperCase() : w.word));

    phrase.forEach((w, i) => {
      // Each word is lit from when it's spoken until the next word starts
      const startMs = i === 0 ? phraseStart : w.startMs;
      const endMs = i + 1 < phrase.length ? phrase[i + 1].startMs : phraseEnd;
      if (endMs <= startMs) return;
      const text = shown
        .map((word, k) => {
          if (k !== i || !look.highlight) return word;
          const pop = look.popScale !== 100 ? `\\fscx${look.popScale}\\fscy${look.popScale}` : '';
          return `{\\c${highlightColour}${pop}}${word}{\\r}`;
        })
        .join(' ');
      dialogues.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), text, style });
    });
  }

  for (const b of banners) {
    const text = b.text.replace(/[{}\\]/g, '').trim();
    // Banners use the top-centred Banner style (bottom ones the base style); the active-word
    // highlight colour picks out the whole banner
    if (text) dialogues.push({ startMs: b.startMs, endMs: b.endMs, text: `{\\c${highlightColour}}${text}`, style: b.position === 'top' ? 'Banner' : look.name });
  }

  const dialogueLines = dialogues.map(
    (d) => `Dialogue: 0,${formatAssTime(d.startMs)},${formatAssTime(d.endMs)},${d.style},,0,0,0,,${d.text}`,
  );
  return { assContent: `${header}${dialogueLines.join('\n')}\n`, dialogues };
}

/**
 * Writes ASS captions to file.
 */
export async function writeAssCaptionsFile(
  options: GenerateCaptionsOptions,
  outputPath: string,
): Promise<string> {
  const { assContent } = generateAssCaptions(options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, assContent, 'utf-8');
  return outputPath;
}

/**
 * Burns an ASS caption file into a video. Audio is stream-copied.
 * ffmpeg runs from the caption file's directory and references it by bare filename,
 * avoiding filter-graph escaping of Windows drive letters and backslashes.
 */
export async function burnCaptions(options: {
  videoPath: string;
  assPath: string;
  outputPath: string;
}): Promise<string> {
  const { videoPath, assPath, outputPath } = options;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const args = [
    '-y',
    '-i',
    path.resolve(videoPath),
    '-vf',
    `ass=${path.basename(assPath)}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    path.resolve(outputPath),
  ];

  try {
    await execFileAsync(getFfmpegPath(), args, { cwd: path.dirname(path.resolve(assPath)) });
    return outputPath;
  } catch (err) {
    throw new Error(
      `FFmpeg failed burning captions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
