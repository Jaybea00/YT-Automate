import { ProviderError, ProviderErrorCode } from './errors';

interface HttpErrorLike {
  status?: number;
  statusCode?: number;
  code?: string;
  name?: string;
  message?: string;
  headers?: Headers | Record<string, string | string[] | undefined>;
}

export function parseRetryAfter(
  headers?: Headers | Record<string, string | string[] | undefined>,
): number | undefined {
  if (!headers) return undefined;

  let headerVal: string | undefined;
  if (typeof (headers as Headers).get === 'function') {
    headerVal = (headers as Headers).get('retry-after') ?? undefined;
  } else {
    const raw = (headers as Record<string, unknown>)['retry-after'];
    if (typeof raw === 'string') headerVal = raw;
    else if (Array.isArray(raw) && typeof raw[0] === 'string') headerVal = raw[0];
  }

  if (!headerVal) return undefined;

  const seconds = Number.parseInt(headerVal, 10);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(headerVal);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }

  return undefined;
}

export function mapHttpOrSdkError(
  error: unknown,
  fallbackMessage = 'Provider call failed',
): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  const err = (error ?? {}) as HttpErrorLike;
  const status = err.status ?? err.statusCode;
  const message = err.message || fallbackMessage;
  const retryAfterMs = parseRetryAfter(err.headers);

  if (err.name === 'AbortError' || err.code === 'ETIMEDOUT' || message.toLowerCase().includes('timeout')) {
    return new ProviderError(`Provider request timed out: ${message}`, {
      code: 'timeout',
      cause: error,
    });
  }

  if (status === 401 || status === 403) {
    return new ProviderError(`Provider authentication failed (${status}): ${message}`, {
      code: 'auth',
      cause: error,
    });
  }

  if (status === 429) {
    return new ProviderError(`Provider rate limit exceeded (${status}): ${message}`, {
      code: 'rate_limit',
      retryAfterMs,
      cause: error,
    });
  }

  if (status && status >= 500 && status < 600) {
    return new ProviderError(`Provider server error (${status}): ${message}`, {
      code: 'transient',
      retryAfterMs,
      cause: error,
    });
  }

  if (status === 400 || status === 422) {
    const lower = message.toLowerCase();
    if (
      lower.includes('content') ||
      lower.includes('policy') ||
      lower.includes('safety') ||
      lower.includes('moderation')
    ) {
      return new ProviderError(`Provider content policy violation: ${message}`, {
        code: 'content_policy',
        cause: error,
      });
    }
    return new ProviderError(`Provider invalid request (${status}): ${message}`, {
      code: 'invalid_request',
      cause: error,
    });
  }

  const msgLower = message.toLowerCase();
  if (
    msgLower.includes('econnreset') ||
    msgLower.includes('econnrefused') ||
    msgLower.includes('fetch failed') ||
    msgLower.includes('network')
  ) {
    return new ProviderError(`Network transient error: ${message}`, {
      code: 'transient',
      cause: error,
    });
  }

  return new ProviderError(message, {
    code: 'unknown' as ProviderErrorCode,
    cause: error,
  });
}
