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
  /** Where each beat's voice really starts in the finished video (from assembly's timeline). */
  voiceStartMs?: Record<number, number>;
  /** The narrator's word timings per beat (seconds from the beat's voice start). */
  words?: Record<number, Array<{ word: string; start: number; end: number }>>;
}

/** Subtitle lines: at most two of this length (the common broadcast limit). */
const LINE_CHARS = 42;
const MIN_CUE_MS = 1000;
const MAX_CUE_MS = 7000;
/** A cue stays up this long after its last word unless the next one starts sooner. */
const CUE_HOLD_MS = 300;

/** Breaks a cue into at most two balanced lines at the space nearest the middle. */
export function wrapCue(text: string): string {
  if (text.length <= LINE_CHARS) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

/**
 * Cues timed to the narrator's words: phrases end at sentence or clause ends and pauses, fit two
 * lines, and stay up between one and seven seconds.
 */
function wordTimedCues(words: Array<{ word: string; startMs: number; endMs: number }>): Array<{ startMs: number; endMs: number; text: string }> {
  const cues: Array<{ startMs: number; endMs: number; text: string }> = [];
  let current: typeof words = [];
  const flush = () => {
    if (current.length) cues.push({ startMs: current[0].startMs, endMs: current[current.length - 1].endMs, text: current.map((w) => w.word).join(' ') });
    current = [];
  };
  for (const [i, w] of words.entries()) {
    const prev = words[i - 1];
    const text = [...current, w].map((x) => x.word).join(' ');
    const tooLong = text.length > LINE_CHARS * 2 || (current.length > 0 && w.endMs - current[0].startMs > MAX_CUE_MS);
    const pause = prev && w.startMs - prev.endMs > 400;
    const sentenceEnded = prev && /[.?!]["”’']?$/.test(prev.word) && current.length > 0;
    const clauseEnded = prev && /[,;:—–]["”’']?$/.test(prev.word) && [...current].map((x) => x.word).join(' ').length > LINE_CHARS;
    if (current.length && (tooLong || pause || sentenceEnded || clauseEnded)) flush();
    current.push(w);
  }
  flush();
  return cues.map((c, i) => {
    const next = cues[i + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    const end = Math.min(next, Math.max(c.startMs + MIN_CUE_MS, c.endMs + CUE_HOLD_MS));
    return { startMs: Math.round(c.startMs), endMs: Math.round(end), text: wrapCue(c.text) };
  });
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

    // With the rendered video's timeline, the beat starts where its voice really starts
    // (after lead-ins and pauses), and its words carry their own timing
    const voiceStart = options.voiceStartMs?.[beat.index];
    if (voiceStart !== undefined) {
      cumulativeMs = voiceStart;
      const timed = options.words?.[beat.index];
      if (timed?.length) {
        const clean = timed
          .map((w) => ({ word: w.word.replace(/[*_#`]/g, '').trim(), startMs: voiceStart + w.start * 1000, endMs: voiceStart + w.end * 1000 }))
          .filter((w) => w.word);
        for (const cue of wordTimedCues(clean)) cues.push({ index: cueCounter++, ...cue });
        cumulativeMs += beatDurationMs;
        continue;
      }
    }

    const beatText = (beat.text || '').trim();
    const chunks = splitTextIntoChunks(beatText, maxCharsPerCue);

    if (chunks.length <= 1) {
      // Single cue for entire beat
      cues.push({
        index: cueCounter++,
        startMs: cumulativeMs,
        endMs: cumulativeMs + beatDurationMs,
        text: beatText ? (voiceStart !== undefined ? wrapCue(beatText) : beatText) : `[Beat ${beat.index + 1}]`,
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
          text: voiceStart !== undefined ? wrapCue(chunk) : chunk,
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
