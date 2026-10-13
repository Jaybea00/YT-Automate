import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '../providers/registry';
import { mapHttpOrSdkError } from '../providers/error-mapper';
import { ProviderError, getRetryDecision } from '../providers/errors';
import { toGeminiResponseSchema } from '../providers/llm/gemini';
import type { LLMProvider, ProviderCallContext } from '../providers/types';
import { loadWordTimings } from './word-timings';

export const VoiceIssueSchema = z.object({
  type: z.enum(['skipped', 'added', 'mispronounced', 'garbled', 'cut_off']),
  expected: z.string().nullable().optional(),
  heard: z.string().nullable().optional(),
});

const CheckResponseSchema = z.object({
  transcript: z.string(),
  issues: z.array(VoiceIssueSchema),
});

export type VoiceIssue = z.infer<typeof VoiceIssueSchema>;

export interface VoiceCheckResult {
  version: 1;
  checkedAt: string;
  /** Size and modification time of the audio checked; a re-voiced beat no longer matches. */
  audioSignature: string;
  ok: boolean;
  transcript: string;
  issues: VoiceIssue[];
}

const AUDIO_MIME: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };

export const voiceCheckPathFor = (audioPath: string) => audioPath.replace(/\.[a-z0-9]+$/i, '') + '.check.json';

async function audioSignature(audioPath: string): Promise<string> {
  const stat = await fs.stat(audioPath);
  return `${stat.size}-${Math.round(stat.mtimeMs)}`;
}

/** A saved check, if it was made on the audio as it is now. */
export async function loadVoiceCheck(audioPath: string): Promise<VoiceCheckResult | null> {
  try {
    const saved = JSON.parse(await fs.readFile(voiceCheckPathFor(audioPath), 'utf-8')) as VoiceCheckResult;
    return saved.version === 1 && saved.audioSignature === (await audioSignature(audioPath)) ? saved : null;
  } catch {
    return null;
  }
}

export function buildVoiceCheckPrompt(expectedText: string): string {
  return `You are checking a text-to-speech recording against the exact text the voice was given.

TEXT GIVEN TO THE VOICE:
"""${expectedText}"""

Listen to the audio and transcribe it. Then report only real problems:
- "skipped": a word or phrase in the text that is not spoken
- "added": words spoken that are not in the text
- "mispronounced": a word said wrongly (wrong word, wrong stress that changes meaning, abbreviation read as letters when it should be a word)
- "garbled": unintelligible or distorted speech
- "cut_off": audio ends before the text does
Spoken forms of written numbers, dates and initials are correct (e.g. "1929" as "nineteen twenty-nine", "U.S." as "U S", "$14" as "fourteen dollars"). Ignore pacing, tone and pauses.
Return {"transcript", "issues": [{"type", "expected", "heard"}]} with an empty issues list when the recording is faithful.`;
}

/** Sends the audio and expected text to Gemini's audio understanding with a JSON reply schema. */
export async function checkVoiceAudio(
  audioPath: string,
  expectedText: string,
  ctx: ProviderCallContext,
): Promise<{ transcript: string; issues: VoiceIssue[] }> {
  const mimeType = AUDIO_MIME[path.extname(audioPath).toLowerCase()] ?? 'audio/mpeg';
  const audio = (await fs.readFile(audioPath)).toString('base64');
  const model = ctx.model || 'gemini-3.5-flash-lite';
  const baseUrl = (ctx.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

  const response = await fetch(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType, data: audio } }, { text: buildVoiceCheckPrompt(expectedText) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiResponseSchema(CheckResponseSchema) ?? undefined,
      },
    }),
    signal: ctx.signal,
  });
  if (!response.ok) {
    throw mapHttpOrSdkError(
      { status: response.status, message: `Voice check failed: ${(await response.text().catch(() => '')).slice(0, 300)}`, headers: response.headers },
      'Voice check failed',
    );
  }

  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const parsed = CheckResponseSchema.safeParse(JSON.parse(text || '{}'));
  if (!parsed.success) {
    throw new ProviderError('Voice check returned an unexpected format', { code: 'invalid_response' });
  }
  return parsed.data;
}

const normalizePhrase = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * Drops "added" reports for words the expected text does contain. In testing these appeared as
 * alignment side effects next to a genuinely skipped phrase (e.g. "bid" flagged as added).
 */
export function dropSpuriousAdditions(issues: VoiceIssue[], expectedText: string): VoiceIssue[] {
  const expected = normalizePhrase(expectedText);
  return issues.filter((issue) => !(issue.type === 'added' && issue.heard && expected.includes(normalizePhrase(issue.heard))));
}

/** Retries Gemini's transient overloads and rate limits (with backoff) before giving up. */
export async function withRetries<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const decision = getRetryDecision(err, attempt, maxRetries);
      if (!decision.retry) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.max(decision.delayMs, 2000)));
    }
  }
}

/** Resolves the Gemini model used for checks (the script stage's fast model). */
export async function resolveVoiceCheckContext(supabase: SupabaseClient): Promise<ProviderCallContext> {
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  if (resolved.providerId !== 'gemini') {
    throw new Error('The voice check needs Gemini (it listens to audio); the script stage uses a different provider.');
  }
  return resolved.ctx;
}

/**
 * Checks one voiced beat and saves the result next to its audio. The expected text is what the
 * voice was actually given (after pronunciation rewrites), from the beat's word-timings file.
 */
export async function runVoiceCheck(
  audioPath: string,
  narration: string,
  ctx: ProviderCallContext,
  options: { force?: boolean } = {},
): Promise<VoiceCheckResult> {
  if (!options.force) {
    const cached = await loadVoiceCheck(audioPath);
    if (cached) return cached;
  }
  const expectedText = (await loadWordTimings(audioPath))?.spokenText ?? narration;
  const checked = await withRetries(() => checkVoiceAudio(audioPath, expectedText, ctx));
  const transcript = checked.transcript;
  const issues = dropSpuriousAdditions(checked.issues, expectedText);
  const result: VoiceCheckResult = {
    version: 1,
    checkedAt: new Date().toISOString(),
    audioSignature: await audioSignature(audioPath),
    ok: issues.length === 0,
    transcript: transcript.trim(),
    issues,
  };
  await fs.writeFile(voiceCheckPathFor(audioPath), JSON.stringify(result, null, 2), 'utf-8');
  return result;
}
