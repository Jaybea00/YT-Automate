import OpenAI from 'openai';
import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { ImageProvider, ProviderCallContext, Usage } from '../types';

export class OpenAiImageProvider implements ImageProvider {
  readonly kind = 'image' as const;
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

  async generate(
    req: { prompt: string; width: number; height: number; seed?: number; negativePrompt?: string },
    ctx: ProviderCallContext,
  ): Promise<{ bytes: Uint8Array; mimeType: string; usage: Usage }> {
    try {
      const client = this.getClient(ctx);
      const model = ctx.model || 'dall-e-3';

      // Pick nearest supported OpenAI resolution if using dall-e-3
      let size: '1024x1024' | '1024x1792' | '1792x1024' = '1792x1024';
      if (req.width === req.height) {
        size = '1024x1024';
      } else if (req.height > req.width) {
        size = '1024x1792';
      }

      const response = await client.images.generate(
        {
          model,
          prompt: req.prompt,
          n: 1,
          size,
          response_format: 'b64_json',
          ...ctx.options,
        },
        {
          signal: ctx.signal,
        },
      );

      const imageData = response.data?.[0];
      if (!imageData) {
        throw new ProviderError('Image provider returned no image data', {
          code: 'invalid_response',
        });
      }

      let bytes: Uint8Array;
      let mimeType = 'image/png';

      if (imageData.b64_json) {
        const buffer = Buffer.from(imageData.b64_json, 'base64');
        bytes = new Uint8Array(buffer);
      } else if (imageData.url) {
        const imgRes = await fetch(imageData.url);
        if (!imgRes.ok) {
          throw new ProviderError(`Failed to download generated image: ${imgRes.statusText}`, {
            code: 'transient',
          });
        }
        const arrayBuf = await imgRes.arrayBuffer();
        bytes = new Uint8Array(arrayBuf);
        mimeType = imgRes.headers.get('content-type') || 'image/png';
      } else {
        throw new ProviderError('Image provider returned neither b64_json nor url', {
          code: 'invalid_response',
        });
      }

      const usage: Usage = {};

      return {
        bytes,
        mimeType,
        usage,
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw mapHttpOrSdkError(error, 'Image generation failed');
    }
  }
}

export const openAiImage = new OpenAiImageProvider('openai', true);
export const openAiCompatImage = new OpenAiImageProvider('openai-compatible', false);
