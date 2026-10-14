/**
 * YouTube Chapter Timestamps Utility
 *
 * Computes exact cumulative timecodes from measured TTS voiceover duration_ms
 * (or fallback script estimates) and formats broadcast-ready YouTube description chapters.
 *
 * YouTube Chapter Requirements:
 * 1. The first timestamp must start at 00:00 (or 0:00).
 * 2. There should be at least 3 timestamps in ascending chronological order.
 * 3. Timestamps are formatted as mm:ss (or hh:mm:ss for videos >= 1 hour).
 */

export interface ScriptBeatLike {
  index: number;
  text?: string;
  title?: string;
  chapter_title?: string;
  visual_query?: string;
  duration_estimate_seconds?: number;
}

export interface UnitTimingLike {
  unit_index: number;
  duration_ms?: number | null;
  status?: string;
}

export interface ChapterItem {
  beatIndex: number;
  startTimeMs: number;
  startTimeSeconds: number;
  timestamp: string;
  title: string;
  durationMs: number;
  isMeasured: boolean;
}

export interface GenerateChaptersOptions {
  beats: ScriptBeatLike[];
  units?: UnitTimingLike[];
  customTitles?: Record<number, string>;
  formatStyle?: 'dash' | 'space';
  /** The story's parts: chapters start only on these beats (one chapter per beat otherwise). */
  sections?: Array<{ start_beat: number; title: string }>;
  /** Where each beat really starts in the finished video, by beat index (from assembly). */
  beatStartMs?: Record<number, number>;
  /** Pause around each beat (lead-in + tail), by beat index, for estimating before assembly. */
  gapMs?: Record<number, number>;
}

/** YouTube ignores chapter lists with fewer than 3 chapters or any chapter under 10 seconds. */
export const MIN_YOUTUBE_CHAPTERS = 3;
export const MIN_CHAPTER_MS = 10_000;

export interface ChapterGenerationResult {
  chapters: ChapterItem[];
  formattedText: string;
  totalDurationMs: number;
  totalDurationSeconds: number;
  hasMeasuredDurations: boolean;
}

/**
 * Format total seconds to mm:ss or hh:mm:ss.
 */
export function formatTimestamp(totalSeconds: number, forceHours = false): string {
  const rounded = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;

  const pad = (n: number) => n.toString().padStart(2, '0');

  if (hours > 0 || forceHours) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Parse a timestamp string ("00:00", "01:23", "01:15:30") to total seconds.
 */
export function parseTimestampToSeconds(ts: string): number {
  const parts = ts.trim().split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => isNaN(p))) return 0;

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] || 0;
}

/**
 * Clean and extract a readable chapter title from a beat's narration or metadata.
 */
export function extractChapterTitle(
  beat: ScriptBeatLike,
  index: number,
  customTitle?: string,
): string {
  if (customTitle && customTitle.trim().length > 0) {
    return customTitle.trim();
  }
  if (beat.chapter_title && beat.chapter_title.trim().length > 0) {
    return beat.chapter_title.trim();
  }
  if (beat.title && beat.title.trim().length > 0) {
    return beat.title.trim();
  }

  // Beat 0 defaults to Introduction if text does not supply a specific heading
  if (index === 0) {
    const raw = (beat.text || '').trim();
    const headingMatch = raw.match(/^(?:intro|introduction|hook):\s*(.+)$/i);
    if (headingMatch && headingMatch[1].trim()) {
      return sanitizeTitle(headingMatch[1].trim());
    }
    return 'Introduction';
  }

  const text = (beat.text || beat.visual_query || '').trim();
  if (!text) {
    return `Part ${index + 1}`;
  }

  // Check common prefixes like "Step 1: Description" or "Tip 2: Description"
  const prefixMatch = text.match(/^(?:step\s*\d+|tip\s*\d+|part\s*\d+|\d+\.)\s*[:\-–]\s*(.+)$/i);
  if (prefixMatch && prefixMatch[1].trim()) {
    return sanitizeTitle(prefixMatch[1].trim());
  }

  // Take the first clause or first sentence up to ~45 chars
  const firstSentence = text.split(/[.\n?!]/)[0].trim();
  return sanitizeTitle(firstSentence || text);
}

function sanitizeTitle(str: string): string {
  // Strip markdown markers, quotes, and trailing punctuation
  let cleaned = str.replace(/[*_#`"']/g, '').replace(/[\s\t]+/g, ' ').trim();
  cleaned = cleaned.replace(/[:\-–—.,;!?]+$/, '').trim();

  if (cleaned.length > 50) {
    cleaned = cleaned.slice(0, 47).trim() + '...';
  }
  if (!cleaned) {
    return 'Chapter';
  }
  // Capitalize first letter
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Generate YouTube chapters with cumulative start times.
 */
export function generateYouTubeChapters(
  options: GenerateChaptersOptions,
): ChapterGenerationResult {
  if (options.sections?.length) return sectionChapters(options);
  const { beats = [], units = [], customTitles = {}, formatStyle = 'dash' } = options;

  if (beats.length === 0) {
    return {
      chapters: [],
      formattedText: '',
      totalDurationMs: 0,
      totalDurationSeconds: 0,
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

  // Sort beats by index ascending
  const sortedBeats = [...beats].sort((a, b) => a.index - b.index);

  let cumulativeMs = 0;
  let hasAnyMeasured = false;

  // First pass: determine total duration to know if hh:mm:ss format is required
  let estimatedTotalMs = 0;
  for (const beat of sortedBeats) {
    const measuredMs = unitTimingMap.get(beat.index);
    const durationMs = measuredMs ?? (beat.duration_estimate_seconds ? beat.duration_estimate_seconds * 1000 : 5000);
    estimatedTotalMs += durationMs;
  }
  const requiresHours = estimatedTotalMs >= 3600 * 1000;

  const chapters: ChapterItem[] = [];

  for (let i = 0; i < sortedBeats.length; i++) {
    const beat = sortedBeats[i];
    const measuredMs = unitTimingMap.get(beat.index);
    const isMeasured = measuredMs !== undefined;
    if (isMeasured) hasAnyMeasured = true;

    const beatDurationMs = isMeasured
      ? measuredMs!
      : (beat.duration_estimate_seconds ? beat.duration_estimate_seconds * 1000 : 5000);

    const startTimeMs = i === 0 ? 0 : cumulativeMs;
    const startTimeSeconds = Math.floor(startTimeMs / 1000);
    const timestamp = formatTimestamp(startTimeSeconds, requiresHours);
    const title = extractChapterTitle(beat, i, customTitles[beat.index]);

    chapters.push({
      beatIndex: beat.index,
      startTimeMs,
      startTimeSeconds,
      timestamp,
      title,
      durationMs: beatDurationMs,
      isMeasured,
    });

    cumulativeMs += beatDurationMs;
  }

  const delimiter = formatStyle === 'space' ? ' ' : ' - ';
  const formattedText = chapters
    .map((c) => `${c.timestamp}${delimiter}${c.title}`)
    .join('\n');

  return {
    chapters,
    formattedText,
    totalDurationMs: cumulativeMs,
    totalDurationSeconds: Math.floor(cumulativeMs / 1000),
    hasMeasuredDurations: hasAnyMeasured,
  };
}

/**
 * Chapters from the story's sections. Start times are where each section's first beat really
 * starts in the video (or an estimate including the pauses), the first is 0:00, and a chapter
 * shorter than YouTube's 10-second minimum merges into the one before. With fewer than three
 * chapters, the formatted text is empty, since YouTube would ignore it.
 */
function sectionChapters(options: GenerateChaptersOptions): ChapterGenerationResult {
  const { beats = [], units = [], customTitles = {}, formatStyle = 'dash', sections = [], beatStartMs, gapMs = {} } = options;
  const sorted = [...beats].sort((a, b) => a.index - b.index);
  const measured = new Map(
    units.filter((u) => typeof u.duration_ms === 'number' && u.duration_ms > 0).map((u) => [u.unit_index, u.duration_ms as number]),
  );

  // Start and length of every beat: exact when assembly reported them, estimated otherwise
  const starts = new Map<number, number>();
  let cursor = 0;
  let hasMeasured = false;
  for (const beat of sorted) {
    const exact = beatStartMs?.[beat.index];
    starts.set(beat.index, exact ?? cursor);
    const voiceMs = measured.get(beat.index);
    if (voiceMs !== undefined) hasMeasured = true;
    cursor = (exact ?? cursor) + (voiceMs ?? (beat.duration_estimate_seconds ?? 5) * 1000) + (gapMs[beat.index] ?? 0);
  }
  const totalMs = cursor;
  const requiresHours = totalMs >= 3600 * 1000;

  const bySection = [...sections]
    .sort((a, b) => a.start_beat - b.start_beat)
    .map((s) => {
      const beat = sorted[s.start_beat];
      return beat ? { beat, title: (customTitles[beat.index] ?? '').trim() || s.title } : null;
    })
    .filter((s): s is { beat: ScriptBeatLike; title: string } => Boolean(s));

  const chapters: ChapterItem[] = [];
  bySection.forEach(({ beat, title }, i) => {
    const startTimeMs = i === 0 ? 0 : starts.get(beat.index) ?? 0;
    const prev = chapters[chapters.length - 1];
    // Too short a chapter for YouTube: fold it into the one before
    if (prev && startTimeMs - prev.startTimeMs < MIN_CHAPTER_MS) return;
    chapters.push({
      beatIndex: beat.index,
      startTimeMs,
      startTimeSeconds: Math.floor(startTimeMs / 1000),
      timestamp: formatTimestamp(Math.floor(startTimeMs / 1000), requiresHours),
      title,
      durationMs: 0,
      isMeasured: measured.has(beat.index) || beatStartMs?.[beat.index] !== undefined,
    });
  });
  // The last chapter also needs 10 seconds
  while (chapters.length > 1 && totalMs - chapters[chapters.length - 1].startTimeMs < MIN_CHAPTER_MS) chapters.pop();
  chapters.forEach((c, i) => {
    c.durationMs = (chapters[i + 1]?.startTimeMs ?? totalMs) - c.startTimeMs;
  });

  const delimiter = formatStyle === 'space' ? ' ' : ' - ';
  return {
    chapters,
    formattedText: chapters.length >= MIN_YOUTUBE_CHAPTERS ? chapters.map((c) => `${c.timestamp}${delimiter}${c.title}`).join('\n') : '',
    totalDurationMs: totalMs,
    totalDurationSeconds: Math.floor(totalMs / 1000),
    hasMeasuredDurations: hasMeasured,
  };
}

/**
 * Parse pasted YouTube chapter lines back into structured items.
 */
export function parseChaptersText(
  rawText: string,
): Array<{ timestamp: string; title: string; seconds: number }> {
  if (!rawText) return [];

  const lines = rawText.split('\n');
  const results: Array<{ timestamp: string; title: string; seconds: number }> = [];

  // Match: "00:00 - Title" or "00:00 Title" or "01:23:45 - Title"
  const regex = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[\-–—]\s*)?(.*)$/;

  for (const line of lines) {
    const match = line.trim().match(regex);
    if (match) {
      const timestamp = match[1];
      const title = match[2]?.trim() || '';
      results.push({
        timestamp,
        title,
        seconds: parseTimestampToSeconds(timestamp),
      });
    }
  }

  return results;
}
