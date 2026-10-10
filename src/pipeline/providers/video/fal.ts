import { ProviderError, ConfigurationError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { VideoProvider, ProviderCallContext, Usage } from '../types';

export interface FalVideoOptions {
  model?: 'veo2' | 'kling' | 'minimax' | 'luma';
  aspectRatio?: '16:9' | '9:16' | '1:1';
  durationSeconds?: number;
  imageUrl?: string;
}

const MODEL_ENDPOINTS: Record<string, string> = {
  veo2: 'fal-ai/veo2',
  kling: 'fal-ai/kling-video/v1.5/pro/text-to-video',
  minimax: 'fal-ai/minimax/video-01',
  luma: 'fal-ai/luma-dream-machine',
};

/**
 * Universal AI Video Generation Provider via Fal.ai gateway.
 * Provides unified access to Google Veo 2, Kling, MiniMax, and Luma.
 */
export class FalVideoProvider implements VideoProvider {
  readonly kind = 'video' as const;
  readonly id = 'fal';
  readonly requiresApiKey = true;

  async generateVideo(
    req: {
      prompt: string;
      durationSeconds?: number;
      aspectRatio?: '16:9' | '9:16' | '1:1';
      model?: string;
      imageUrl?: string;
    },
    ctx: ProviderCallContext = { apiKey: '', options: {} },
  ): Promise<{ videoUrl: string; durationSeconds?: number; usage?: Usage }> {
    const apiKey = ctx.apiKey || process.env.FAL_KEY;
    if (!apiKey) {
      throw new ConfigurationError(
        'FAL_KEY is not configured yet. Add FAL_KEY=... in your .env file to enable Google Veo, Kling, and MiniMax AI video generation.',
      );
    }

    const cleanPrompt = req.prompt.trim();
    if (!cleanPrompt) {
      throw new ProviderError('Prompt cannot be empty for video generation', {
        code: 'invalid_request',
      });
    }

    const modelKey = req.model || (ctx.options.model as string) || 'veo2';
    const endpoint = MODEL_ENDPOINTS[modelKey] || MODEL_ENDPOINTS.veo2;
    const aspectRatio = req.aspectRatio || (ctx.options.aspectRatio as any) || '16:9';

    try {
      // 1. Submit job to Fal queue
      const submitUrl = `https://queue.fal.run/${endpoint}`;
      const payload: Record<string, any> = {
        prompt: cleanPrompt,
        aspect_ratio: aspectRatio,
      };

      if (req.imageUrl) {
        payload.image_url = req.imageUrl;
      }

      const submitRes = await fetch(submitUrl, {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'YT-Automation/1.0',
        },
        body: JSON.stringify(payload),
        signal: ctx.signal,
      });

      if (!submitRes.ok) {
        const errorText = await submitRes.text().catch(() => '');
        throw new ProviderError(
          `Fal.ai submit failed with HTTP ${submitRes.status}: ${errorText}`,
          { code: submitRes.status >= 500 ? 'transient' : 'invalid_request' },
        );
      }

      const submitData = await submitRes.json();
      const requestId = submitData.request_id;
      if (!requestId) {
        // Direct response if endpoint is synchronous
        const directUrl = submitData.video?.url || submitData.video_url;
        if (directUrl) {
          return { videoUrl: directUrl, durationSeconds: req.durationSeconds || 5 };
        }
        throw new ProviderError('No request_id returned from Fal.ai queue', {
          code: 'invalid_response',
        });
      }

      // 2. Poll for video completion
      const pollUrl = `https://queue.fal.run/${endpoint}/requests/${requestId}`;
      const statusUrl = `https://queue.fal.run/${endpoint}/requests/${requestId}/status`;
      const startTime = Date.now();
      const timeoutMs = 300000; // 5 minute max timeout

      while (Date.now() - startTime < timeoutMs) {
        if (ctx.signal?.aborted) {
          throw new ProviderError('Video generation aborted', { code: 'aborted' });
        }

        // Wait 3 seconds between status polls
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const statusRes = await fetch(statusUrl, {
          headers: { Authorization: `Key ${apiKey}` },
          signal: ctx.signal,
        });

        if (!statusRes.ok) continue;

        const statusData = await statusRes.json();
        if (statusData.status === 'COMPLETED') {
          // Fetch final result
          const resultRes = await fetch(pollUrl, {
            headers: { Authorization: `Key ${apiKey}` },
            signal: ctx.signal,
          });

          if (!resultRes.ok) {
            throw new ProviderError(`Failed to fetch completed Fal result: HTTP ${resultRes.status}`, {
              code: 'transient',
            });
          }

          const resultData = await resultRes.json();
          const videoUrl =
            resultData.video?.url ||
            resultData.video_url ||
            resultData.response?.video?.url;

          if (!videoUrl) {
            throw new ProviderError('Fal result payload did not contain a valid video URL', {
              code: 'invalid_response',
            });
          }

          return {
            videoUrl,
            durationSeconds: req.durationSeconds || 5,
            usage: { costUsd: modelKey === 'veo2' ? 0.2 : 0.1 },
          };
        } else if (statusData.status === 'FAILED') {
          throw new ProviderError(
            `Fal video generation failed: ${statusData.error || 'Unknown error'}`,
            { code: 'invalid_response' },
          );
        }
      }

      throw new ProviderError('Video generation timed out after 5 minutes', {
        code: 'timeout',
      });
    } catch (err) {
      if (err instanceof ProviderError || err instanceof ConfigurationError) {
        throw err;
      }
      throw mapHttpOrSdkError(err, 'Fal.ai video generation failed');
    }
  }
}

export const falVideo = new FalVideoProvider();
