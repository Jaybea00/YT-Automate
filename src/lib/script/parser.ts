import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider } from '@/pipeline/providers/types';
import {
  ScriptBeat,
  GeneratedScript,
  GeneratedScriptSchema,
  withWritingModel,
} from './generate-script';
import { VideoStyle, VISUAL_TYPE_RULES } from './style-templates';
import { estimateSpeechSeconds, normalizeBeats } from './script-quality';

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
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
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

const QUERY_STOPWORDS = new Set(
  `a an the and or but if then than so of in on at to for from by with without into onto over under about
  after before during until while as is are was were be been being have has had do does did will would
  can could should may might must shall this that these those it its they them their there here he she
  his her him we our us you your i me my not no nor just only also very more most much many some any
  all each every both few other such what which who whom whose when where why how one two first last
  out up down off again further once said says say like even still yet ever never really quite
  within across through between among around behind beyond toward towards against along upon`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Derives a stock-search hint from narration without an LLM: drops filler words and keeps
 * up to six meaningful words (names, places, objects) in their original order.
 */
export function extractQuickVisualQuery(text: string): string {
  const words = text
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length > 1 && !QUERY_STOPWORDS.has(w.toLowerCase()));

  const seen = new Set<string>();
  const unique = words.filter((w) => {
    const key = w.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, 6).join(' ');
}

const ABBREVIATIONS = new Set(
  'mr mrs ms dr st jr sr vs etc inc co corp ltd no mt gen gov sen rep prof jan feb mar apr jun jul aug sep sept oct nov dec'.split(' '),
);

/**
 * Splits text into sentences without breaking on abbreviations ("U.S. Steel", "J.P. Morgan", "Wall St.").
 */
export function splitSentences(text: string): string[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const sentences: string[] = [];
  let current: string[] = [];

  tokens.forEach((token, i) => {
    current.push(token);
    const core = token.replace(/["'”’)\]]+$/, '');
    if (!/[.!?]$/.test(core)) return;

    const bare = core.replace(/[.!?]+$/, '').replace(/^["'“‘(\[]+/, '');
    const isInitials = /^([A-Za-z]\.)*[A-Za-z]$/.test(bare) && core.endsWith('.');
    const isAbbreviation = ABBREVIATIONS.has(bare.toLowerCase()) && core.endsWith('.');
    const next = tokens[i + 1];
    const nextStartsSentence = !next || /^["'“‘(\[]*[A-Z0-9]/.test(next);

    if (!isInitials && !isAbbreviation && nextStartsSentence) {
      sentences.push(current.join(' '));
      current = [];
    }
  });
  if (current.length) sentences.push(current.join(' '));
  return sentences;
}

/**
 * Packs whole sentences into beats of roughly 12-35 words. Sentences are never split;
 * a short trailing group is folded into the previous beat when that stays readable.
 */
export function packSentencesIntoBeats(sentences: string[]): string[] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean).length;
    if (current.length && (currentWords >= 20 || currentWords + words > 35)) {
      groups.push(current);
      current = [];
      currentWords = 0;
    }
    current.push(sentence);
    currentWords += words;
  }
  if (current.length) groups.push(current);

  const wordCount = (g: string[]) => g.join(' ').split(/\s+/).filter(Boolean).length;
  if (groups.length > 1 && wordCount(groups[groups.length - 1]) < 8) {
    const tail = groups.pop()!;
    const prev = groups[groups.length - 1];
    if (wordCount(prev) + wordCount(tail) <= 45) {
      prev.push(...tail);
    } else {
      groups.push(tail);
    }
  }
  return groups.map((g) => g.join(' '));
}

export interface ParseSrtOptions {
  /**
   * If > 0 (default 4.0), regroups cue text into whole-sentence beats of 12-35 words
   * (smart merge). Set to 0 to keep one beat per subtitle cue.
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

  // Subtitle cues are usually cut mid-sentence, and the narration is re-voiced anyway, so cue
  // timing only matters for long pauses: those mark paragraph breaks. Within a paragraph the
  // text is regrouped into whole-sentence beats, exactly like a pasted script.
  const paragraphs: string[] = [];
  let current: string[] = [];
  rawCues.forEach((cue, i) => {
    const prev = rawCues[i - 1];
    if (prev && cue.startTimeSeconds - prev.endTimeSeconds > maxGapSeconds && current.length) {
      paragraphs.push(current.join(' '));
      current = [];
    }
    current.push(cue.text);
  });
  if (current.length) paragraphs.push(current.join(' '));

  const beats: ScriptBeat[] = [];
  for (const paragraph of paragraphs) {
    for (const beatText of packSentencesIntoBeats(splitSentences(paragraph))) {
      beats.push({
        index: beats.length,
        text: beatText,
        visual_type: 'stock',
        visual_query: extractQuickVisualQuery(beatText),
        duration_estimate_seconds: estimateSpeechSeconds(beatText),
      });
    }
  }

  return mergeTinyBeats(beats);
}

/** Folds beats under 6 words into the previous beat (a two-word beat can't carry its own visual). */
function mergeTinyBeats(beats: ScriptBeat[]): ScriptBeat[] {
  const merged: ScriptBeat[] = [];
  for (const beat of beats) {
    const prev = merged[merged.length - 1];
    if (prev && beat.text.split(/\s+/).filter(Boolean).length < 6) {
      prev.text = `${prev.text} ${beat.text}`;
      prev.visual_query = extractQuickVisualQuery(prev.text);
      prev.duration_estimate_seconds =
        Math.round((prev.duration_estimate_seconds + beat.duration_estimate_seconds) * 10) / 10;
    } else {
      merged.push({ ...beat, index: merged.length });
    }
  }
  return merged;
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

    // Long paragraphs become several beats so no single visual holds for a minute
    for (const beatText of packSentencesIntoBeats(splitSentences(clean))) {
      beats.push({
        index: beats.length,
        text: beatText,
        visual_type: 'stock',
        visual_query: extractQuickVisualQuery(beatText),
        duration_estimate_seconds: Math.max(3, Math.round(estimateSpeechSeconds(beatText))),
      });
    }
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
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  const llm = resolved.provider;
  const ctx = withWritingModel(resolved.ctx, resolved.options);

  const topicContext = options?.topic ? `Topic: "${options.topic}"` : '';
  const styleContext = options?.style ? `Style: "${options.style}"` : '';

  const systemPrompt = `You are an expert video director and editor.
Your task is to take the user-provided raw script text and segment it into natural narration beats (12-35 words each).
CRITICAL RULES:
1. Preserve the user's spoken words exactly. Do NOT rewrite, reorder, add, or remove content.
2. Group sentences logically so each beat represents a single coherent scene. Never split a sentence across beats.
3. For each beat, choose visual_type and visual_query using the rules below.
4. Provide 3 compelling YouTube title options matching the script (under 60 characters, accurate).

${VISUAL_TYPE_RULES}

Return valid JSON adhering strictly to this shape:
{
  "title_options": ["Title 1", "Title 2", "Title 3"],
  "beats": [
    {
      "index": 0,
      "text": "the narration sentence(s) for this beat",
      "visual_type": "stock",
      "visual_query": "specific b-roll description",
      "duration_estimate_seconds": 6
    }
  ]
}`;

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

  return {
    title_options: result.data.title_options || ['My Video'],
    beats: normalizeBeats(result.data.beats),
  };
}

/**
 * Visual planning for uploads that were split without AI (paragraphs, SRT): asks the LLM for
 * visual types and search hints, leaving the user's words untouched. Upload must never fail
 * because of this, so any error returns the beats unchanged.
 */
export async function planVisualsForUploadedBeats(
  supabase: SupabaseClient,
  beats: ScriptBeat[],
  topic?: string,
): Promise<ScriptBeat[]> {
  try {
    return await enrichBeatsWithAiVisualHints(supabase, beats, topic);
  } catch (err) {
    console.warn('[planVisualsForUploadedBeats] Visual planning failed; keeping keyword hints:', err);
    return beats;
  }
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
        visual_type: z.enum(['screen_recording', 'stock', 'chart', 'geo_map', 'archive', 'newspaper']),
        visual_query: z.string(),
      }),
    ),
  });

  const prompt = `Topic: "${topic || 'Video'}"
For each of the following narration beats, generate a rich visual_query hint describing relevant footage, and choose visual_type ('stock', 'chart', 'newspaper', 'geo_map', 'archive', or 'screen_recording'):
${JSON.stringify(
  beats.map((b) => ({ index: b.index, text: b.text })),
  null,
  2,
)}

Return valid JSON adhering to this exact shape:
{
  "visual_hints": [
    {
      "index": 0,
      "visual_type": "stock",
      "visual_query": "b-roll footage search description"
    }
  ]
}`;

  const result = await llm.generateJson<z.infer<typeof schema>>(
    {
      system: `You are a visual director. Choose the most engaging, accurate visual for each narration line.\n\n${VISUAL_TYPE_RULES}`,
      prompt,
      schema,
    },
    ctx,
  );

  const hintsMap = new Map(result.data.visual_hints.map((h) => [h.index, h]));

  const enriched = beats.map((b) => {
    const hint = hintsMap.get(b.index);
    if (!hint) return b;
    return {
      ...b,
      visual_type: hint.visual_type,
      visual_query: hint.visual_query,
    };
  });
  // Same deterministic guards as generated scripts (e.g. charts need two quantities)
  return normalizeBeats(enriched);
}
