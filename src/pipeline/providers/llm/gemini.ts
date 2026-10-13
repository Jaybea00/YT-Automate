import { GoogleGenerativeAI, type ResponseSchema } from '@google/generative-ai';
import { z, type ZodType } from 'zod';
import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { LLMProvider, ProviderCallContext, Usage } from '../types';

const FALLBACK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
];

/** How long a model that reported being overloaded is skipped before being tried again. */
const BUSY_COOLDOWN_MS = 10 * 60 * 1000;
const busyUntil = new Map<string, number>();

export function markModelBusy(model: string, now = Date.now()): void {
  busyUntil.set(model, now + BUSY_COOLDOWN_MS);
}

export function resetModelCooldowns(): void {
  busyUntil.clear();
}

/**
 * Primary first, then fallbacks of the same tier (lite vs full), so a busy full model doesn't
 * silently degrade to lite. Models that recently reported overload move to the end, so a
 * multi-call job doesn't wait on the same failing models for every call.
 */
export function modelFallbackOrder(primaryModel: string, now = Date.now()): string[] {
  const isLite = (m: string) => /lite/i.test(m);
  const rest = FALLBACK_MODELS.filter((m) => m !== primaryModel);
  const ordered = [
    primaryModel,
    ...rest.filter((m) => isLite(m) === isLite(primaryModel)),
    ...rest.filter((m) => isLite(m) !== isLite(primaryModel)),
  ];
  const isBusy = (m: string) => (busyUntil.get(m) ?? 0) > now;
  return [...ordered.filter((m) => !isBusy(m)), ...ordered.filter(isBusy)];
}

function isFallbackEligible(error: unknown): boolean {
  const err = error as Record<string, any>;
  const status = err?.status || err?.cause?.status;
  const msg = `${err?.message || ''} ${err?.cause?.message || ''}`;
  return (
    status === 503 ||
    status === 429 ||
    status === 500 ||
    status === 404 ||
    /503|429|demand|unavailable|overloaded|resource_exhausted|not found/i.test(msg)
  );
}

type JsonSchemaNode = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  description?: string;
  anyOf?: JsonSchemaNode[];
};

/**
 * Converts a JSON Schema node (from zod) into Gemini's OpenAPI-subset response schema.
 * Returns null for anything outside that subset, in which case the caller skips constrained decoding.
 */
function jsonSchemaToGemini(node: JsonSchemaNode): Record<string, unknown> | null {
  // zod renders .nullable() on objects as anyOf [schema, {type: null}]
  if (node.anyOf) {
    const nonNull = node.anyOf.filter((n) => n.type !== 'null');
    if (nonNull.length !== 1 || nonNull.length === node.anyOf.length) return null;
    const inner = jsonSchemaToGemini(nonNull[0]);
    return inner ? { ...inner, nullable: true } : null;
  }

  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const nonNull = types.filter((t) => t !== 'null');
  if (nonNull.length !== 1) return null;
  const type = nonNull[0];

  const out: Record<string, unknown> = { type };
  if (types.includes('null')) out.nullable = true;
  if (node.description) out.description = node.description;

  if (type === 'string' && node.enum) {
    if (!node.enum.every((v) => typeof v === 'string')) return null;
    out.format = 'enum';
    out.enum = node.enum;
  } else if (type === 'object') {
    const entries = Object.entries(node.properties ?? {});
    if (entries.length === 0) return null;
    const properties: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      const converted = jsonSchemaToGemini(child);
      if (!converted) return null;
      properties[key] = converted;
    }
    out.properties = properties;
    if (node.required?.length) out.required = node.required;
  } else if (type === 'array') {
    const items = node.items ? jsonSchemaToGemini(node.items) : null;
    if (!items) return null;
    out.items = items;
  } else if (!['string', 'number', 'integer', 'boolean'].includes(type)) {
    return null;
  }
  return out;
}

export function toGeminiResponseSchema(schema: ZodType<unknown>): ResponseSchema | null {
  try {
    return jsonSchemaToGemini(z.toJSONSchema(schema) as JsonSchemaNode) as ResponseSchema | null;
  } catch {
    return null;
  }
}

function isSchemaRejection(error: unknown): boolean {
  const err = error as { status?: number; message?: string; cause?: { status?: number } } | undefined;
  const status = err?.status || err?.cause?.status;
  return status === 400 || /400|invalid argument|response_?schema/i.test(String(err?.message ?? ''));
}

export class GeminiLlmProvider implements LLMProvider {
  readonly kind = 'llm' as const;
  readonly id: string;
  readonly requiresApiKey: boolean;

  constructor(id: string = 'gemini', requiresApiKey: boolean = true) {
    this.id = id;
    this.requiresApiKey = requiresApiKey;
  }

  async generateText(
    req: { system?: string; prompt: string; maxTokens?: number; temperature?: number },
    ctx: ProviderCallContext,
  ): Promise<{ text: string; usage: Usage }> {
    const primaryModel = ctx.model || 'gemini-3.5-flash-lite';
    const modelsToTry = modelFallbackOrder(primaryModel);

    let lastError: unknown;
    for (const modelName of modelsToTry) {
      try {
        const genAI = new GoogleGenerativeAI(ctx.apiKey);
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: req.system,
          generationConfig: {
            maxOutputTokens: req.maxTokens,
            temperature: req.temperature,
          },
        });

        const result = await model.generateContent(req.prompt);
        const text = result.response.text();
        const usageMetadata = result.response.usageMetadata;

        return {
          text,
          usage: {
            inputTokens: usageMetadata?.promptTokenCount,
            outputTokens: usageMetadata?.candidatesTokenCount,
          },
        };
      } catch (error) {
        lastError = error;
        if (isFallbackEligible(error)) {
          markModelBusy(modelName);
          console.warn(
            `[GeminiLlmProvider] Model "${modelName}" failed with demand/capacity error. Trying fallback model...`,
          );
          continue;
        }
        throw mapHttpOrSdkError(error, 'Gemini generateText call failed');
      }
    }

    throw mapHttpOrSdkError(lastError, 'All Gemini fallback models failed');
  }

  async generateJson<T>(
    req: { system?: string; prompt: string; schema: ZodType<T>; maxTokens?: number },
    ctx: ProviderCallContext,
  ): Promise<{ data: T; usage: Usage }> {
    const primaryModel = ctx.model || 'gemini-3.5-flash-lite';
    const modelsToTry = modelFallbackOrder(primaryModel);

    // Constrained decoding makes Gemini emit JSON matching the schema (no unquoted strings, missing fields)
    let responseSchema = toGeminiResponseSchema(req.schema);

    let lastError: unknown;
    for (const modelName of modelsToTry) {
      try {
        const genAI = new GoogleGenerativeAI(ctx.apiKey);
        const buildModel = () =>
          genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: req.system,
            generationConfig: {
              responseMimeType: 'application/json',
              maxOutputTokens: req.maxTokens,
              ...(responseSchema ? { responseSchema } : {}),
            },
          });

        let result;
        try {
          result = await buildModel().generateContent(req.prompt);
        } catch (schemaErr) {
          if (!responseSchema || !isSchemaRejection(schemaErr)) throw schemaErr;
          console.warn(
            `[GeminiLlmProvider] Model "${modelName}" rejected the response schema; retrying without it.`,
          );
          responseSchema = null;
          result = await buildModel().generateContent(req.prompt);
        }
        const text = result.response.text();
        const usageMetadata = result.response.usageMetadata;

        let parsed: unknown;
        try {
          const cleaned = text.replace(/^```json\s*|\s*```$/g, '').trim();
          parsed = JSON.parse(cleaned);
        } catch (parseError) {
          throw new ProviderError(
            `Gemini did not return valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            {
              code: 'invalid_response',
              cause: parseError,
            },
          );
        }

        // Resilient normalization: If LLM returned raw array but schema expects an object containing an array
        if (Array.isArray(parsed)) {
          const shape = (req.schema as any)?._def?.shape?.() || (req.schema as any)?._def?.shape;
          if (shape && typeof shape === 'object') {
            for (const key of Object.keys(shape)) {
              const testCandidate = { [key]: parsed };
              if (req.schema.safeParse(testCandidate).success) {
                parsed = testCandidate;
                break;
              }
            }
          }
        }

        const validation = req.schema.safeParse(parsed);
        if (!validation.success) {
          throw new ProviderError(
            `Gemini response failed schema validation: ${validation.error.message}`,
            {
              code: 'invalid_response',
              cause: validation.error,
            },
          );
        }

        return {
          data: validation.data,
          usage: {
            inputTokens: usageMetadata?.promptTokenCount,
            outputTokens: usageMetadata?.candidatesTokenCount,
          },
        };
      } catch (error) {
        lastError = error;
        if (error instanceof ProviderError) {
          console.warn(
            `[GeminiLlmProvider] Model "${modelName}" JSON parsing/validation issue (${error.message.slice(0, 300)}). Trying fallback model...`,
          );
          continue;
        }
        if (isFallbackEligible(error)) {
          markModelBusy(modelName);
          console.warn(
            `[GeminiLlmProvider] Model "${modelName}" failed with demand/capacity error. Trying fallback model...`,
          );
          continue;
        }
        throw mapHttpOrSdkError(error, 'Gemini generateJson call failed');
      }
    }

    if (lastError instanceof ProviderError) throw lastError;
    throw mapHttpOrSdkError(lastError, 'All Gemini fallback models failed');
  }
}

export const geminiLlm = new GeminiLlmProvider();
