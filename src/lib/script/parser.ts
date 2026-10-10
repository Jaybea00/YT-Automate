import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider } from '@/pipeline/providers/types';
import { ScriptBeat, GeneratedScript, GeneratedScriptSchema } from './generate-script';
import { VideoStyle } from './style-templates';

/**
 * Parses an SRT timestamp format ("HH:MM:SS,mmm" or "HH:MM:SS.mmm") into seconds.
 */
export function parseSrtTimestampToSeconds(timestampStr: string): number {
  const clean = timestampStr.trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const minutes = parseFloat(parts[1]) || 0;
    const seconds = parseFloat(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
  if (parts.length === 2) {
    const minutes = parseFloat(parts[0]) || 0;
    const seconds = parseFloat(parts[1]) || 0;
    return minutes * 60 + seconds;
  }
  return parseFloat(clean) || 0;
}

export interface SrtCue {
  index: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  durationSeconds: number;
  text: string;
}

/**
 * Extracts raw cues from an SRT file content.
 */
export function extractSrtCues(srtContent: string): SrtCue[] {
  if (!srtContent || !srtContent.trim()) {
    return [];
  }

  // Normalize line breaks
  const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n\s*\n/);
  const cues: SrtCue[] = [];

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length < 2) continue;

    // Line 0 is usually cue index, line 1 is timestamp line
    // or line 0 might be timestamp if index is omitted
    let timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx === -1) continue;

    const timeLine = lines[timeLineIdx];
    const textLines = lines.slice(timeLineIdx + 1);
    const [startStr, endStr] = timeLine.split('-->').map((s) => s.trim());

    if (!startStr || !endStr) continue;

    const startTimeSeconds = parseSrtTimestampToSeconds(startStr);
    const endTimeSeconds = parseSrtTimestampToSeconds(endStr);
    const durationSeconds = Math.max(0.5, endTimeSeconds - startTimeSeconds);

    // Clean formatting tags (e.g., <i>, <b>, <font...>)
    const cleanText = textLines
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanText) continue;

    cues.push({
      index: cues.length + 1,
      startTimeSeconds,
      endTimeSeconds,
      durationSeconds,
      text: cleanText,
    });
  }

  return cues;
}

/**
 * Derives a concise visual query hint from narration text.
 */
export function extractQuickVisualQuery(text: string): string {
  // Strip punctuation and take the first 6-10 descriptive words
  const words = text
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length <= 8) {
    return words.join(' ');
  }
  return words.slice(0, 8).join(' ');
}

export interface ParseSrtOptions {
  /**
   * If > 0, groups short consecutive subtitle cues together until the combined duration
   * reaches at least minBeatDurationSeconds (default: 4.0s). Set to 0 to keep individual cues.
   */
  minBeatDurationSeconds?: number;
  /** Max gap between subtitles in seconds before forcing a new beat (default: 1.5s). */
  maxGapSeconds?: number;
}

/**
 * Parses an SRT subtitle file into pipeline ScriptBeat objects with smart merging.
 */
export function parseSrtToBeats(
  srtContent: string,
  options: ParseSrtOptions = {},
): ScriptBeat[] {
  const { minBeatDurationSeconds = 4.0, maxGapSeconds = 1.5 } = options;
  const rawCues = extractSrtCues(srtContent);

  if (rawCues.length === 0) {
    return [];
  }

  // If minBeatDurationSeconds <= 0, map 1-to-1
  if (minBeatDurationSeconds <= 0) {
    return rawCues.map((cue, idx) => ({
      index: idx,
      text: cue.text,
      visual_type: 'stock',
      visual_query: extractQuickVisualQuery(cue.text),
      duration_estimate_seconds: Math.round(cue.durationSeconds * 10) / 10,
    }));
  }

  const beats: ScriptBeat[] = [];
  let currentGroup: SrtCue[] = [];

  for (let i = 0; i < rawCues.length; i++) {
    const cue = rawCues[i];

    if (currentGroup.length === 0) {
      currentGroup.push(cue);
      continue;
    }

    const lastCue = currentGroup[currentGroup.length - 1];
    const gap = cue.startTimeSeconds - lastCue.endTimeSeconds;
    const currentDuration =
      lastCue.endTimeSeconds - currentGroup[0].startTimeSeconds;

    // Check if we should flush the current group:
    // 1. Duration already meets or exceeds target AND last text ends with sentence punct (.!?)
    // 2. Or gap between cues is larger than maxGapSeconds
    // 3. Or duration exceeds 8 seconds
    const endsWithSentence = /[.!?]$/.test(lastCue.text);
    const shouldFlush =
      (currentDuration >= minBeatDurationSeconds && endsWithSentence) ||
      currentDuration >= 8.0 ||
      gap > maxGapSeconds;

    if (shouldFlush) {
      const mergedText = currentGroup.map((c) => c.text).join(' ');
      const totalDuration =
        lastCue.endTimeSeconds - currentGroup[0].startTimeSeconds;

      beats.push({
        index: beats.length,
        text: mergedText,
        visual_type: 'stock',
        visual_query: extractQuickVisualQuery(mergedText),
        duration_estimate_seconds: Math.max(
          1,
          Math.round(totalDuration * 10) / 10,
        ),
      });

      currentGroup = [cue];
    } else {
      currentGroup.push(cue);
    }
  }

  if (currentGroup.length > 0) {
    const lastCue = currentGroup[currentGroup.length - 1];
    const mergedText = currentGroup.map((c) => c.text).join(' ');
    const totalDuration =
      lastCue.endTimeSeconds - currentGroup[0].startTimeSeconds;

    beats.push({
      index: beats.length,
      text: mergedText,
      visual_type: 'stock',
      visual_query: extractQuickVisualQuery(mergedText),
      duration_estimate_seconds: Math.max(
        1,
        Math.round(totalDuration * 10) / 10,
      ),
    });
  }

  return beats;
}

/**
 * Splits raw script text into beats based on paragraphs or double newlines (zero LLM tokens used).
 */
export function parseRawTextToParagraphBeats(rawText: string): ScriptBeat[] {
  if (!rawText || !rawText.trim()) {
    return [];
  }

  const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const beats: ScriptBeat[] = [];

  for (const para of paragraphs) {
    // Strip markdown header lines (e.g. # Title, ## Section) as they are section markers, not narration
    const lines = para.split('\n');
    const contentLines = lines.filter((l) => !/^#{1,6}\s+/.test(l.trim()));
    const clean = contentLines
      .join(' ')
      .replace(/^[-*•]\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!clean) continue;

    // Estimate duration using standard ~140 words per minute (2.3 words/sec)
    const wordCount = clean.split(/\s+/).filter(Boolean).length;
    const estimatedSeconds = Math.max(3, Math.round(wordCount / 2.3));

    beats.push({
      index: beats.length,
      text: clean,
      visual_type: 'stock',
      visual_query: extractQuickVisualQuery(clean),
      duration_estimate_seconds: estimatedSeconds,
    });
  }

  return beats;
}

/**
 * Uses the configured LLM provider to segment raw text into spoken beats and generate visual hints.
 */
export async function parseRawTextWithAi(
  supabase: SupabaseClient,
  rawText: string,
  options?: { topic?: string; style?: VideoStyle },
): Promise<GeneratedScript> {
  const { provider, ctx } = await resolveForStage<LLMProvider>('script', supabase);
  const llm = provider;

  const topicContext = options?.topic ? `Topic: "${options.topic}"` : '';
  const styleContext = options?.style ? `Style: "${options.style}"` : '';

  const systemPrompt = `You are an expert video director and editor.
Your task is to take the user-provided raw script text and segment it into natural narration beats (~10-25 words each).
CRITICAL RULES:
1. Preserve the user's spoken words faithfully. Do NOT rewrite or remove content.
2. Group sentences logically so each beat represents a single coherent scene.
3. For each beat, suggest an accurate "visual_query" describing b-roll footage or visual assets to display.
4. Set "visual_type" to 'stock', 'chart' (if discussing numerical figures), or 'screen_recording' (if referencing software/websites).
5. Estimate duration_estimate_seconds based on ~2.3 words per second.
6. Provide 3 compelling YouTube title options matching the script.`;

  const userPrompt = `${topicContext} ${styleContext}
Raw script to segment:
"""
${rawText}
"""`;

  const result = await llm.generateJson<GeneratedScript>(
    {
      system: systemPrompt,
      prompt: userPrompt,
      schema: GeneratedScriptSchema,
    },
    ctx,
  );

  // Normalize beat indices to 0-based
  return {
    title_options: result.data.title_options || ['My Video'],
    beats: result.data.beats.map((b, idx) => ({
      ...b,
      index: idx,
    })),
  };
}

/**
 * Generates tailored visual query hints and visual types for existing beats using the LLM.
 * Leaves the spoken text and duration unchanged.
 */
export async function enrichBeatsWithAiVisualHints(
  supabase: SupabaseClient,
  beats: ScriptBeat[],
  topic?: string,
): Promise<ScriptBeat[]> {
  if (beats.length === 0) return [];

  const { provider, ctx } = await resolveForStage<LLMProvider>('script', supabase);
  const llm = provider;

  const schema = z.object({
    visual_hints: z.array(
      z.object({
        index: z.number(),
        visual_type: z.enum(['screen_recording', 'stock', 'chart']),
        visual_query: z.string(),
      }),
    ),
  });

  const prompt = `Topic: "${topic || 'Video'}"
For each of the following narration beats, generate a rich visual_query hint describing relevant footage, and choose visual_type ('stock', 'chart', or 'screen_recording'):
${JSON.stringify(
  beats.map((b) => ({ index: b.index, text: b.text })),
  null,
  2,
)}`;

  const result = await llm.generateJson<z.infer<typeof schema>>(
    {
      system: 'You are a visual director. Suggest the most engaging visuals for each narration line.',
      prompt,
      schema,
    },
    ctx,
  );

  const hintsMap = new Map(result.data.visual_hints.map((h) => [h.index, h]));

  return beats.map((b) => {
    const hint = hintsMap.get(b.index);
    if (!hint) return b;
    return {
      ...b,
      visual_type: hint.visual_type,
      visual_query: hint.visual_query,
    };
  });
}
