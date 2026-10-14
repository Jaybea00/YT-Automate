import { createHash } from 'node:crypto';

/**
 * Deterministically stringifies an object by recursively sorting its keys.
 */
export function stableStringify(val: unknown): string {
  if (val === null || val === undefined) {
    return JSON.stringify(val);
  }
  if (typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(val as Record<string, unknown>).sort();
  const pairs = keys.map((key) => {
    const item = (val as Record<string, unknown>)[key];
    return `${JSON.stringify(key)}:${stableStringify(item)}`;
  });
  return `{${pairs.join(',')}}`;
}

/**
 * Calculates a SHA256 hex digest for an input string or object.
 */
export function sha256(input: unknown): string {
  const content = typeof input === 'string' ? input : stableStringify(input);
  return createHash('sha256').update(content).digest('hex');
}

export interface UnitHashInput {
  stage: string;
  input: unknown;
  providerId: string;
  model?: string | null;
  baseUrl?: string | null;
  options?: Record<string, unknown>;
}

/**
 * Computes input_hash = sha256(stableStringify({ stage, input, providerId, model, baseUrl, options }))
 * If input and providerId are not explicitly specified, hashes the whole object deterministically.
 */
export function computeInputHash(params: UnitHashInput | Record<string, unknown>): string {
  if ('input' in params && 'providerId' in params) {
    return sha256({
      stage: params.stage,
      input: params.input,
      providerId: params.providerId,
      model: params.model ?? '',
      baseUrl: params.baseUrl ?? '',
      options: params.options ?? {},
    });
  }
  return sha256(params);
}

/**
 * Computes script fingerprint to detect changes in approved script
 */
export function computeScriptFingerprint(script: unknown): string {
  return sha256(script);
}
