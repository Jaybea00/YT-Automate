import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { ImageProvider, ProviderCallContext, Usage } from '../types';

export interface PollinationsImageOptions {
  model?: string;
  seed?: number;
  enhance?: boolean;
}

/**
 * Free, open AI Image Generation provider via Pollinations.ai.
 * Requires zero API keys. Supports high-resolution 1920x1080 16:9 generation.
 */
export class PollinationsImageProvider implements ImageProvider {
  readonly kind = 'image' as const;
  readonly id = 'pollinations';
  readonly requiresApiKey = false;

  async generate(
    req: { prompt: string; width: number; height: number; seed?: number; negativePrompt?: string },
    ctx: ProviderCallContext = { apiKey: '', options: {} },
  ): Promise<{ bytes: Uint8Array; mimeType: string; usage: Usage }> {
    try {
      const cleanPrompt = req.prompt.trim();
      if (!cleanPrompt) {
        throw new ProviderError('Prompt cannot be empty for image generation', {
          code: 'invalid_request',
        });
      }

      const width = req.width || 1920;
      const height = req.height || 1080;
      const seed = req.seed ?? Math.floor(Math.random() * 1000000);

      // Build Pollinations URL
      const url = new URL(`https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}`);
      url.searchParams.set('width', String(width));
      url.searchParams.set('height', String(height));
      url.searchParams.set('seed', String(seed));
      url.searchParams.set('nologo', 'true');

      const timeoutMs = 60000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;

      let res: Response;
      try {
        res = await fetch(url.toString(), {
          headers: {
            'User-Agent': 'YT-Automation/1.0',
            Accept: 'image/jpeg, image/png, image/*',
          },
          signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new ProviderError(`Pollinations API failed with HTTP ${res.status}: ${errorText}`, {
          code: res.status >= 500 ? 'transient' : 'invalid_request',
        });
      }

      const mimeType = res.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await res.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      if (bytes.length < 500) {
        throw new ProviderError('Pollinations returned unexpectedly small or empty image payload', {
          code: 'invalid_response',
        });
      }

      return {
        bytes,
        mimeType,
        usage: {},
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw mapHttpOrSdkError(err, 'Pollinations image generation failed');
    }
  }
}

export const pollinationsImage = new PollinationsImageProvider();
