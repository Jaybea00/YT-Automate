import type { ZodType } from 'zod';
import OpenAI from 'openai';
import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { LLMProvider, ProviderCallContext, Usage } from '../types';

export class OpenAiLlmProvider implements LLMProvider {
  readonly kind = 'llm' as const;
  readonly id: string;
  readonly requiresApiKey: boolean;

  constructor(id: string = 'openai', requiresApiKey: boolean = true) {
    this.id = id;
    this.requiresApiKey = requiresApiKey;
  }

  private getClient(ctx: ProviderCallContext): OpenAI {
    return new OpenAI({
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
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      if (req.system) {
        messages.push({ role: 'system', content: req.system });
      }
      messages.push({ role: 'user', content: req.prompt });

      const model = ctx.model || 'gpt-4o';
      const temperature = req.temperature ?? (ctx.options.temperature as number | undefined);
      const maxTokens = req.maxTokens ?? (ctx.options.max_tokens as number | undefined);

      const completion = await client.chat.completions.create(
        {
          model,
          messages,
          temperature,
          max_completion_tokens: maxTokens,
          ...ctx.options,
        },
        {
          signal: ctx.signal,
        },
      );

      const choice = completion.choices[0];
      const text = choice?.message?.content ?? '';

      const usage: Usage = {
        inputTokens: completion.usage?.prompt_tokens,
        outputTokens: completion.usage?.completion_tokens,
      };

      return { text, usage };
    } catch (error) {
      throw mapHttpOrSdkError(error, 'OpenAI generateText call failed');
    }
  }

  async generateJson<T>(
    req: { system?: string; prompt: string; schema: ZodType<T>; maxTokens?: number },
    ctx: ProviderCallContext,
  ): Promise<{ data: T; usage: Usage }> {
    try {
      const client = this.getClient(ctx);
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      const systemPrompt = req.system
        ? `${req.system}\nYou must output valid JSON matching the requested structure.`
        : 'You must output valid JSON.';

      messages.push({ role: 'system', content: systemPrompt });
      messages.push({ role: 'user', content: req.prompt });

      const model = ctx.model || 'gpt-4o';
      const maxTokens = req.maxTokens ?? (ctx.options.max_tokens as number | undefined);

      const completion = await client.chat.completions.create(
        {
          model,
          messages,
          response_format: { type: 'json_object' },
          max_completion_tokens: maxTokens,
          ...ctx.options,
        },
        {
          signal: ctx.signal,
        },
      );

      const text = completion.choices[0]?.message?.content ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (parseError) {
        throw new ProviderError(
          `Provider did not return valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          {
            code: 'invalid_response',
            cause: parseError,
          },
        );
      }

      const result = req.schema.safeParse(parsed);
      if (!result.success) {
        throw new ProviderError(`Provider response failed schema validation: ${result.error.message}`, {
          code: 'invalid_response',
          cause: result.error,
        });
      }

      const usage: Usage = {
        inputTokens: completion.usage?.prompt_tokens,
        outputTokens: completion.usage?.completion_tokens,
      };

      return { data: result.data, usage };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw mapHttpOrSdkError(error, 'OpenAI generateJson call failed');
    }
  }
}

export const openAiLlm = new OpenAiLlmProvider('openai', true);
export const openAiCompatLlm = new OpenAiLlmProvider('openai-compatible', false);
