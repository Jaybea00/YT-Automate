import Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';
import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { LLMProvider, ProviderCallContext, Usage } from '../types';

export class AnthropicLlmProvider implements LLMProvider {
  readonly kind = 'llm' as const;
  readonly id: string;
  readonly requiresApiKey: boolean;

  constructor(id: string = 'anthropic', requiresApiKey: boolean = true) {
    this.id = id;
    this.requiresApiKey = requiresApiKey;
  }

  private getClient(ctx: ProviderCallContext): Anthropic {
    return new Anthropic({
      apiKey: ctx.apiKey || 'dummy-key',
      baseURL: ctx.baseUrl || undefined,
    });
  }

  async generateText(
    req: { system?: string; prompt: string; maxTokens?: number; temperature?: number },
    ctx: ProviderCallContext,
  ): Promise<{ text: string; usage: Usage }> {
    try {
      const client = this.getClient(ctx);
      const model = ctx.model || 'claude-sonnet-5';

      const response = await client.messages.create({
        model,
        max_tokens: req.maxTokens || 4096,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
        temperature: req.temperature,
      });

      const textBlock = response.content.find((block) => block.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('Claude returned no text content.');
      }

      return {
        text: textBlock.text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      throw mapHttpOrSdkError(error, 'Anthropic generateText call failed');
    }
  }

  async generateJson<T>(
    req: { system?: string; prompt: string; schema: ZodType<T>; maxTokens?: number },
    ctx: ProviderCallContext,
  ): Promise<{ data: T; usage: Usage }> {
    try {
      const client = this.getClient(ctx);
      const model = ctx.model || 'claude-sonnet-5';

      const systemPrompt = req.system
        ? `${req.system}\nYou must output valid JSON only — no prose before or after, no markdown fences.`
        : 'You must output valid JSON only.';

      const response = await client.messages.create({
        model,
        max_tokens: req.maxTokens || 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: req.prompt }],
      });

      const textBlock = response.content.find((block) => block.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('Claude returned no text content.');
      }

      const text = textBlock.text;
      let parsed: unknown;
      try {
        const cleaned = text.replace(/^```json\s*|\s*```$/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch (parseError) {
        throw new ProviderError(
          `Claude did not return valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          {
            code: 'invalid_response',
            cause: parseError,
          },
        );
      }

      const validation = req.schema.safeParse(parsed);
      if (!validation.success) {
        throw new ProviderError(`Claude response failed schema validation: ${validation.error.message}`, {
          code: 'invalid_response',
          cause: validation.error,
        });
      }

      return {
        data: validation.data,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw mapHttpOrSdkError(error, 'Anthropic generateJson call failed');
    }
  }
}

export const anthropicLlm = new AnthropicLlmProvider();
