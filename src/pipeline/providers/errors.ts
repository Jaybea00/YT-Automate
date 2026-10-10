export type ProviderErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'transient'
  | 'timeout'
  | 'aborted'
  | 'content_policy'
  | 'invalid_request'
  | 'invalid_response'
  | 'unknown';

export interface ProviderErrorOptions {
  code: ProviderErrorCode;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryAfterMs?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message);
    this.name = 'ProviderError';
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    if (options.cause) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, ProviderError.prototype);
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

/**
 * Evaluates whether an error should be retried based on the pipeline policy.
 * - rate_limit: retry, honoring retryAfterMs if provided
 * - transient: retry with exponential backoff (capped at 60s)
 * - auth, content_policy, invalid_request, invalid_response, timeout: DO NOT retry
 */
export function getRetryDecision(
  error: unknown,
  attempt: number, // 1-indexed attempt number
  maxRetries: number = 1,
): { retry: boolean; delayMs: number; reason?: string } {
  if (attempt > maxRetries) {
    return { retry: false, delayMs: 0, reason: `Max retries (${maxRetries}) exceeded` };
  }

  if (error instanceof ProviderError) {
    switch (error.code) {
      case 'rate_limit': {
        const delayMs = error.retryAfterMs !== undefined && error.retryAfterMs > 0
          ? Math.min(error.retryAfterMs, 60_000)
          : Math.min(1000 * Math.pow(2, attempt - 1), 60_000);
        return { retry: true, delayMs, reason: 'rate_limit' };
      }
      case 'transient': {
        const delayMs = error.retryAfterMs !== undefined && error.retryAfterMs > 0
          ? Math.min(error.retryAfterMs, 60_000)
          : Math.min(1000 * Math.pow(2, attempt - 1), 60_000);
        return { retry: true, delayMs, reason: 'transient' };
      }
      case 'timeout':
        return { retry: false, delayMs: 0, reason: 'timeout_no_auto_retry' };
      case 'aborted':
        return { retry: false, delayMs: 0, reason: 'aborted_no_retry' };
      case 'auth':
      case 'content_policy':
      case 'invalid_request':
      case 'invalid_response':
      case 'unknown':
      default:
        return { retry: false, delayMs: 0, reason: error.code };
    }
  }

  // Generic errors (network errors, ECONNRESET, etc.) can be treated as transient if detected
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('fetch failed') || msg.includes('network')) {
    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 60_000);
    return { retry: true, delayMs, reason: 'network_transient' };
  }

  return { retry: false, delayMs: 0, reason: 'non_retryable_error' };
}
