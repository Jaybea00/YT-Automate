/**
 * Subtitle Generation Utility (.SRT and .VTT)
 *
 * Generates broadcast-ready SubRip (.srt) and WebVTT (.vtt) closed caption files
 * with exact timecodes calculated from measured TTS voiceover duration_ms.
 *
 * Subtitles can be uploaded directly to YouTube Studio or embedded via <track>
 * in HTML5 video players.
 */

export interface SubtitleCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface BeatTimingLike {
  index: number;
  text?: string;
  duration_estimate_seconds?: number;
}

export interface UnitDurationLike {
  unit_index: number;
  duration_ms?: number | null;
  stage?: string;
  status?: string;
}

export interface GenerateSubtitlesOptions {
  beats: BeatTimingLike[];
  units?: UnitDurationLike[];
  maxCharsPerCue?: number; // default 80
}

export interface SubtitlesResult {
  cues: SubtitleCue[];
  srt: string;
  vtt: string;
  totalDurationMs: number;
  hasMeasuredDurations: boolean;
}

/**
 * Format milliseconds to SRT timestamp: HH:MM:SS,mmm
 */
export function formatSrtTime(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;

  const pad = (n: number, z = 2) => n.toString().padStart(z, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/**
 * Format milliseconds to WebVTT timestamp: HH:MM:SS.mmm
 */
export function formatVttTime(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;

  const pad = (n: number, z = 2) => n.toString().padStart(z, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

/**
 * Split text into natural subtitle sentences / chunks.
 */
export function splitTextIntoChunks(text: string, maxChars = 80): string[] {
  const cleaned = text.replace(/[*_#`]/g, '').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  // Try splitting by sentence end punctuation
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (!sentences) return [cleaned];

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (!current) {
      current = trimmed;
    } else if ((current + ' ' + trimmed).length <= maxChars) {
      current += ' ' + trimmed;
    } else {
      chunks.push(current);
      current = trimmed;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [cleaned];
}

/**
 * Generate synchronized SRT and WebVTT subtitles from beats and measured unit durations.
 */
export function generateSubtitles(options: GenerateSubtitlesOptions): SubtitlesResult {
  const { beats = [], units = [], maxCharsPerCue = 80 } = options;

  if (beats.length === 0) {
    return {
      cues: [],
      srt: '',
      vtt: 'WEBVTT\n\n',
      totalDurationMs: 0,
      hasMeasuredDurations: false,
    };
  }

  // Map measured durations by unit_index
  const unitTimingMap = new Map<number, number>();
  for (const u of units) {
    if (typeof u.unit_index === 'number' && typeof u.duration_ms === 'number' && u.duration_ms > 0) {
      unitTimingMap.set(u.unit_index, u.duration_ms);
    }
  }

  const sortedBeats = [...beats].sort((a, b) => a.index - b.index);

  const cues: SubtitleCue[] = [];
  let cumulativeMs = 0;
  let hasAnyMeasured = false;
  let cueCounter = 1;

  for (let i = 0; i < sortedBeats.length; i++) {
    const beat = sortedBeats[i];
    const measuredMs = unitTimingMap.get(beat.index);
    const isMeasured = measuredMs !== undefined;
    if (isMeasured) hasAnyMeasured = true;

    const beatDurationMs = isMeasured
      ? measuredMs!
      : (beat.duration_estimate_seconds ? beat.duration_estimate_seconds * 1000 : 5000);

    const beatText = (beat.text || '').trim();
    const chunks = splitTextIntoChunks(beatText, maxCharsPerCue);

    if (chunks.length <= 1) {
      // Single cue for entire beat
      cues.push({
        index: cueCounter++,
        startMs: cumulativeMs,
        endMs: cumulativeMs + beatDurationMs,
        text: beatText || `[Beat ${beat.index + 1}]`,
      });
    } else {
      // Distribute beat duration proportionally across chunks
      const totalChars = chunks.reduce((acc, c) => acc + c.length, 0) || 1;
      let chunkStart = cumulativeMs;

      for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
        const chunk = chunks[cIdx];
        const isLast = cIdx === chunks.length - 1;
        const chunkDuration = isLast
          ? (cumulativeMs + beatDurationMs) - chunkStart
          : Math.round((chunk.length / totalChars) * beatDurationMs);

        const chunkEnd = isLast
          ? cumulativeMs + beatDurationMs
          : chunkStart + chunkDuration;

        cues.push({
          index: cueCounter++,
          startMs: chunkStart,
          endMs: chunkEnd,
          text: chunk,
        });

        chunkStart = chunkEnd;
      }
    }

    cumulativeMs += beatDurationMs;
  }

  // Format SRT
  const srtBlocks = cues.map((cue) => {
    return `${cue.index}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}\n`;
  });
  const srt = srtBlocks.join('\n').trim() + '\n';

  // Format WebVTT
  const vttBlocks = cues.map((cue) => {
    return `${cue.index}\n${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}\n${cue.text}\n`;
  });
  const vtt = `WEBVTT - YouTube Automation Subtitles\n\n${vttBlocks.join('\n')}`.trim() + '\n';

  return {
    cues,
    srt,
    vtt,
    totalDurationMs: cumulativeMs,
    hasMeasuredDurations: hasAnyMeasured,
  };
}
