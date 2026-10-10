import type { ZodType } from 'zod';
import type { LLMProvider, ProviderCallContext, Usage } from './types';
import { getRetryDecision } from './errors';
import { mapHttpOrSdkError } from './error-mapper';

/**
 * Executes an LLM generateJson call with retry and backoff logic using getRetryDecision,
 * mirroring the retry semantics used in generateScript().
 * Retries transient 500-599 errors (like 503 high demand spikes), rate limits, and network errors.
 */
export async function callLlmJsonWithRetry<T>(
  llmProvider: LLMProvider,
  req: { system?: string; prompt: string; schema: ZodType<T>; maxTokens?: number },
  ctx: ProviderCallContext,
  maxRetries: number = 2,
  logTag: string = '',
): Promise<{ data: T; usage: Usage }> {
  let attempt = 1;
  while (attempt <= maxRetries + 1) {
    try {
      return await llmProvider.generateJson<T>(req, ctx);
    } catch (err) {
      const mappedErr = mapHttpOrSdkError(err);
      const decision = getRetryDecision(mappedErr, attempt, maxRetries);
      if (decision.retry && attempt <= maxRetries) {
        const errMsg = mappedErr.message;
        const tag = logTag ? `${logTag} ` : '';
        console.warn(
          `${tag}LLM call failed with retryable error (attempt ${attempt}/${maxRetries + 1}, backing off ${decision.delayMs}ms): ${errMsg}`,
        );
        attempt++;
        if (decision.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
        }
        continue;
      }
      throw mappedErr;
    }
  }
  throw new Error(`${logTag ? logTag + ' ' : ''}Exceeded max retries (${maxRetries})`);
}

/**
 * Executes an LLM generateText call with retry and backoff logic using getRetryDecision.
 */
export async function callLlmTextWithRetry(
  llmProvider: LLMProvider,
  req: { system?: string; prompt: string; maxTokens?: number; temperature?: number },
  ctx: ProviderCallContext,
  maxRetries: number = 2,
  logTag: string = '',
): Promise<{ text: string; usage: Usage }> {
  let attempt = 1;
  while (attempt <= maxRetries + 1) {
    try {
      return await llmProvider.generateText(req, ctx);
    } catch (err) {
      const mappedErr = mapHttpOrSdkError(err);
      const decision = getRetryDecision(mappedErr, attempt, maxRetries);
      if (decision.retry && attempt <= maxRetries) {
        const errMsg = mappedErr.message;
        const tag = logTag ? `${logTag} ` : '';
        console.warn(
          `${tag}LLM call failed with retryable error (attempt ${attempt}/${maxRetries + 1}, backing off ${decision.delayMs}ms): ${errMsg}`,
        );
        attempt++;
        if (decision.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
        }
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${logTag ? logTag + ' ' : ''}Exceeded max retries (${maxRetries})`);
}
