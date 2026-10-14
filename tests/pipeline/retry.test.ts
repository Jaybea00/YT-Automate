import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRetryDecision, ProviderError } from '../../src/pipeline/providers/errors.ts';
import { mapHttpOrSdkError } from '../../src/pipeline/providers/error-mapper.ts';

describe('Retry Policy & Error Classification', () => {
  it('does NOT auto-retry auth errors', () => {
    const err = new ProviderError('Invalid API key', { code: 'auth' });
    const decision = getRetryDecision(err, 1, 3);
    assert.equal(decision.retry, false);
    assert.equal(decision.reason, 'auth');
  });

  it('does NOT auto-retry content_policy errors', () => {
    const err = new ProviderError('Safety violation detected', { code: 'content_policy' });
    const decision = getRetryDecision(err, 1, 3);
    assert.equal(decision.retry, false);
    assert.equal(decision.reason, 'content_policy');
  });

  it('does NOT auto-retry invalid_request or invalid_response', () => {
    const errReq = new ProviderError('Bad prompt format', { code: 'invalid_request' });
    const decisionReq = getRetryDecision(errReq, 1, 3);
    assert.equal(decisionReq.retry, false);

    const errRes = new ProviderError('Schema mismatch', { code: 'invalid_response' });
    const decisionRes = getRetryDecision(errRes, 1, 3);
    assert.equal(decisionRes.retry, false);
  });

  it('does NOT auto-retry timeouts on paid generation calls', () => {
    const err = new ProviderError('Upstream call timed out after 30s', { code: 'timeout' });
    const decision = getRetryDecision(err, 1, 3);
    assert.equal(decision.retry, false);
    assert.equal(decision.reason, 'timeout_no_auto_retry');
  });

  it('does NOT auto-retry aborted errors', () => {
    const err = new ProviderError('Unit execution aborted', { code: 'aborted' });
    const decision = getRetryDecision(err, 1, 3);
    assert.equal(decision.retry, false);
    assert.equal(decision.reason, 'aborted_no_retry');
  });

  it('retries rate_limit errors and honors retryAfterMs', () => {
    const errWithHeader = new ProviderError('Rate limit exceeded', {
      code: 'rate_limit',
      retryAfterMs: 4500,
    });
    const decisionWithHeader = getRetryDecision(errWithHeader, 1, 2);
    assert.equal(decisionWithHeader.retry, true);
    assert.equal(decisionWithHeader.delayMs, 4500);

    // Rate limit without header falls back to exponential backoff
    const errWithoutHeader = new ProviderError('Rate limit exceeded', { code: 'rate_limit' });
    const decisionWithoutHeader = getRetryDecision(errWithoutHeader, 2, 3);
    assert.equal(decisionWithoutHeader.retry, true);
    assert.equal(decisionWithoutHeader.delayMs, 2000); // 1000 * 2^(2-1)
  });

  it('retries transient errors with exponential backoff capped at 60s', () => {
    const err = new ProviderError('Service temporarily unavailable', { code: 'transient' });

    const dec1 = getRetryDecision(err, 1, 5);
    assert.equal(dec1.retry, true);
    assert.equal(dec1.delayMs, 1000);

    const dec2 = getRetryDecision(err, 2, 5);
    assert.equal(dec2.retry, true);
    assert.equal(dec2.delayMs, 2000);

    const dec3 = getRetryDecision(err, 3, 5);
    assert.equal(dec3.retry, true);
    assert.equal(dec3.delayMs, 4000);

    const decHigh = getRetryDecision(err, 10, 10);
    assert.equal(decHigh.retry, true);
    assert.equal(decHigh.delayMs, 60000); // Capped at 60s
  });

  it('does NOT retry when maxRetries is exceeded', () => {
    const err = new ProviderError('Temporary glitch', { code: 'transient' });
    const decision = getRetryDecision(err, 2, 1); // attempt 2 with maxRetries = 1
    assert.equal(decision.retry, false);
  });

  it('maps HTTP status codes and headers accurately', () => {
    // 401/403 -> auth
    const authErr = mapHttpOrSdkError({ status: 401, message: 'Unauthorized' });
    assert.equal(authErr.code, 'auth');

    // 429 -> rate_limit with retry-after
    const rateLimitErr = mapHttpOrSdkError({
      status: 429,
      message: 'Too Many Requests',
      headers: { 'retry-after': '5' },
    });
    assert.equal(rateLimitErr.code, 'rate_limit');
    assert.equal(rateLimitErr.retryAfterMs, 5000);

    // 503 -> transient
    const transientErr = mapHttpOrSdkError({ status: 503, message: 'Overloaded' });
    assert.equal(transientErr.code, 'transient');

    // Abort / timeout
    const timeoutErr = mapHttpOrSdkError({ name: 'AbortError', message: 'Request aborted' });
    assert.equal(timeoutErr.code, 'timeout');
  });
});
