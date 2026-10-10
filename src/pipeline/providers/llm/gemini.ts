import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ZodType } from 'zod';
import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { LLMProvider, ProviderCallContext, Usage } from '../types';

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
    try {
      const genAI = new GoogleGenerativeAI(ctx.apiKey);
      const modelName = ctx.model || 'gemini-2.5-flash';
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
      throw mapHttpOrSdkError(error, 'Gemini generateText call failed');
    }
  }

  async generateJson<T>(
    req: { system?: string; prompt: string; schema: ZodType<T>; maxTokens?: number },
    ctx: ProviderCallContext,
  ): Promise<{ data: T; usage: Usage }> {
    try {
      const genAI = new GoogleGenerativeAI(ctx.apiKey);
      const modelName = ctx.model || 'gemini-2.5-flash';
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: req.system,
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: req.maxTokens,
        },
      });

      const result = await model.generateContent(req.prompt);
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

      const validation = req.schema.safeParse(parsed);
      if (!validation.success) {
        throw new ProviderError(`Gemini response failed schema validation: ${validation.error.message}`, {
          code: 'invalid_response',
          cause: validation.error,
        });
      }

      return {
        data: validation.data,
        usage: {
          inputTokens: usageMetadata?.promptTokenCount,
          outputTokens: usageMetadata?.candidatesTokenCount,
        },
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw mapHttpOrSdkError(error, 'Gemini generateJson call failed');
    }
  }
}

export const geminiLlm = new GeminiLlmProvider();
