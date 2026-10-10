import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import { getRetryDecision } from '@/pipeline/providers/errors';
import type { LLMProvider } from '@/pipeline/providers/types';
import { STYLE_TEMPLATES, VideoStyle } from './style-templates';

export interface ScriptBeat {
  index: number;
  text: string;
  visual_type: 'screen_recording' | 'stock' | 'chart';
  visual_query: string;
  duration_estimate_seconds: number;
}

export interface GeneratedScript {
  title_options: string[];
  beats: ScriptBeat[];
}

export const ScriptBeatSchema = z.object({
  index: z.number(),
  text: z.string(),
  visual_type: z.enum(['screen_recording', 'stock', 'chart']),
  visual_query: z.string(),
  duration_estimate_seconds: z.number(),
});

export const GeneratedScriptSchema = z.object({
  title_options: z.array(z.string()),
  beats: z.array(ScriptBeatSchema),
});

export interface GenerateScriptInput {
  topic: string;
  style: VideoStyle;
  targetMinutes: number;
  /** Set when revising — the prior script plus the user's requested changes. */
  revisionOf?: { previousScript: GeneratedScript; feedback: string };
}

export function buildUserPrompt(input: GenerateScriptInput): string {
  return input.revisionOf
    ? `Revise this existing script for the topic "${input.topic}" (target ~${input.targetMinutes} minutes).
Requested changes: ${input.revisionOf.feedback}

Previous script JSON:
${JSON.stringify(input.revisionOf.previousScript, null, 2)}`
    : `Write a script for the topic "${input.topic}". Target runtime: ~${input.targetMinutes} minutes.`;
}

/**
 * Runs script generation for a video.
 * Resolves the configured provider for the 'script' stage via the pipeline registry,
 * applies Zod schema validation, and wraps execution in the registry's retry policy
 * (covering 429 rate limits and 503 transient errors).
 */
export async function generateScript(
  supabase: SupabaseClient,
  input: GenerateScriptInput,
): Promise<GeneratedScript> {
  const { provider, ctx, maxRetries = 2 } = await resolveForStage<LLMProvider>('script', supabase);
  const template = STYLE_TEMPLATES[input.style];
  if (!template) {
    throw new Error(`Unknown video style: "${input.style}". Valid styles: ${Object.keys(STYLE_TEMPLATES).join(', ')}`);
  }
  const userPrompt = buildUserPrompt(input);

  let currentAttempt = 1;
  let lastError: unknown;

  while (currentAttempt <= maxRetries + 1) {
    try {
      const response = await provider.generateJson<GeneratedScript>(
        {
          system: template.systemPrompt,
          prompt: userPrompt,
          schema: GeneratedScriptSchema,
        },
        ctx,
      );

      const parsed = response.data;
      if (!Array.isArray(parsed.beats) || parsed.beats.length === 0) {
        throw new Error('Script generation returned no beats.');
      }

      return parsed;
    } catch (err) {
      lastError = err;
      const decision = getRetryDecision(err, currentAttempt, maxRetries);

      if (decision.retry && currentAttempt <= maxRetries) {
        currentAttempt++;
        if (decision.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
        }
        continue;
      }
      break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}