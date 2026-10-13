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

export interface GenerateCaptionsOptions {
  beats: BeatTimingLike[];
  units?: UnitDurationLike[];
  preset?: CaptionPreset;
  outputAssPath?: string;
  /**
   * Actual start time (ms) of each beat in the final video, aligned with `beats`.
   * When omitted, beats are laid back-to-back using their speech durations.
   */
  beatStartMs?: number[];
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

/**
 * Builds kinetic ASS subtitles with high-retention active word color highlights.
 */
export function generateAssCaptions(options: GenerateCaptionsOptions): {
  assContent: string;
  dialogues: CaptionDialogue[];
} {
  const { beats, units = [], preset = 'vox', beatStartMs } = options;

  const styleName = preset === 'social_pop' ? 'SocialPop' : preset === 'clean_news' ? 'CleanNews' : 'VoxMinimal';
  // Social Pop's base text is yellow, so its active word pops in white instead of gold
  const highlightColour = preset === 'social_pop' ? '&HFFFFFF&' : '&H00D4FF&';

  // ASS header with styles
  const header = `[Script Info]
Title: YT-Automation Kinetic Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: VoxMinimal, Inter, 54, &H00FFFFFF, &H0000D4FF, &H00000000, &H80000000, 1, 0, 0, 0, 100, 100, 0, 0, 1, 2, 0, 2, 100, 100, 80, 1
Style: SocialPop, Montserrat, 62, &H0000FFFF, &H00FFFFFF, &H00000000, &H00000000, 1, 0, 0, 0, 100, 100, 0, 0, 1, 4, 3, 2, 80, 80, 100, 1
Style: CleanNews, Arial, 46, &H00FFFFFF, &H00FFFFFF, &H00000000, &H90000000, 0, 0, 0, 0, 100, 100, 0, 0, 3, 2, 0, 2, 80, 80, 60, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const dialogues: CaptionDialogue[] = [];
  let currentStartMs = 0;

  for (const [beatPos, beat] of beats.entries()) {
    if (beatStartMs?.[beatPos] != null) {
      currentStartMs = beatStartMs[beatPos];
    }
    const unit = units.find((u) => u.unit_index === beat.index && u.duration_ms != null && u.duration_ms > 0);
    const durationMs = unit?.duration_ms ?? Math.round((beat.duration_estimate_seconds ?? 4) * 1000);
    // Braces and backslashes are ASS override syntax; strip them so narration can't inject tags
    const text = (beat.text || '').replace(/[*_#`{}\\]/g, '').trim();

    if (!text) {
      currentStartMs += durationMs;
      continue;
    }

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      currentStartMs += durationMs;
      continue;
    }

    // Chunk into 3-4 word phrases with active word highlighting
    const chunkSize = 4;
    const wordDurationMs = durationMs / words.length;

    for (let i = 0; i < words.length; i += chunkSize) {
      const chunkWords = words.slice(i, i + chunkSize);
      const chunkStartMs = currentStartMs + i * wordDurationMs;
      const chunkEndMs = Math.min(currentStartMs + durationMs, chunkStartMs + chunkWords.length * wordDurationMs);

      // Sub-step word highlights within this chunk
      for (let wIdx = 0; wIdx < chunkWords.length; wIdx++) {
        const wStartMs = chunkStartMs + wIdx * wordDurationMs;
        const wEndMs = Math.min(chunkEndMs, wStartMs + wordDurationMs);

        // Highlight the current word; {\r} resets the rest back to the style's own colour
        const styledText = chunkWords
          .map((w, idx) => {
            if (idx === wIdx) {
              return `{\\c${highlightColour}}${w}{\\r}`;
            }
            return w;
          })
          .join(' ');

        dialogues.push({
          startMs: Math.round(wStartMs),
          endMs: Math.round(wEndMs),
          text: styledText,
          style: styleName,
        });
      }
    }

    currentStartMs += durationMs;
  }

  const dialogueLines = dialogues.map(
    (d) =>
      `Dialogue: 0,${formatAssTime(d.startMs)},${formatAssTime(d.endMs)},${d.style},,0,0,0,,${d.text}`,
  );

  const assContent = `${header}${dialogueLines.join('\n')}\n`;
  return { assContent, dialogues };
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
