import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BeatTimingLike, UnitDurationLike } from '../utils/subtitles';

export type CaptionPreset = 'vox' | 'social_pop' | 'clean_news';

export interface GenerateCaptionsOptions {
  beats: BeatTimingLike[];
  units?: UnitDurationLike[];
  preset?: CaptionPreset;
  outputAssPath?: string;
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
  const { beats, units = [], preset = 'vox' } = options;

  const styleName = preset === 'social_pop' ? 'SocialPop' : preset === 'clean_news' ? 'CleanNews' : 'VoxMinimal';

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

  for (const beat of beats) {
    const unit = units.find((u) => u.unit_index === beat.index && u.duration_ms != null && u.duration_ms > 0);
    const durationMs = unit?.duration_ms ?? Math.round((beat.duration_estimate_seconds ?? 4) * 1000);
    const text = (beat.text || '').replace(/[*_#`]/g, '').trim();

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

        // Format chunk with current word highlighted in gold (&H00D4FF&) and others in white
        const styledText = chunkWords
          .map((w, idx) => {
            if (idx === wIdx) {
              return `{\\c&H00D4FF&}${w}{\\c&HFFFFFF&}`;
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
