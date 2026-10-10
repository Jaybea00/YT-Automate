import { ProviderError, ConfigurationError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { VideoProvider, ProviderCallContext, Usage } from '../types';

export interface GoogleVeoOptions {
  model?: string;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  durationSeconds?: number;
}

/**
 * Direct Google Veo 2 Video Provider using Google Generative Language API (Google AI Studio / Vertex).
 * Accepts GOOGLE_VEO_API_KEY, GOOGLE_API_KEY, or GEMINI_API_KEY directly.
 */
export class GoogleVeoVideoProvider implements VideoProvider {
  readonly kind = 'video' as const;
  readonly id = 'google_veo';
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
    const apiKey =
      ctx.apiKey ||
      process.env.GOOGLE_VEO_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new ConfigurationError(
        'Google Veo API key is not configured yet. Add GOOGLE_VEO_API_KEY=... (or GEMINI_API_KEY / GOOGLE_API_KEY) in your .env file.',
      );
    }

    const cleanPrompt = req.prompt.trim();
    if (!cleanPrompt) {
      throw new ProviderError('Prompt cannot be empty for Google Veo video generation', {
        code: 'invalid_request',
      });
    }

    const model = req.model || (ctx.options.model as string) || 'veo-2.0-generate-001';
    const aspectRatio = req.aspectRatio || (ctx.options.aspectRatio as string) || '16:9';
    const durationSeconds = req.durationSeconds || 5;

    try {
      // 1. Submit long-running video generation request
      const submitUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning?key=${apiKey}`;

      const payload: Record<string, any> = {
        instances: [
          {
            prompt: cleanPrompt,
          },
        ],
        parameters: {
          aspectRatio,
          durationSeconds,
          sampleCount: 1,
        },
      };

      if (req.imageUrl) {
        payload.instances[0].image = { imageUri: req.imageUrl };
      }

      const submitRes = await fetch(submitUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'YT-Automation/1.0',
        },
        body: JSON.stringify(payload),
        signal: ctx.signal,
      });

      if (!submitRes.ok) {
        const errorText = await submitRes.text().catch(() => '');
        throw new ProviderError(
          `Google Veo submit failed with HTTP ${submitRes.status}: ${errorText}`,
          { code: submitRes.status >= 500 ? 'transient' : 'invalid_request' },
        );
      }

      const submitData = await submitRes.json();
      const operationName = submitData.name;
      if (!operationName) {
        throw new ProviderError('No operation name returned from Google Veo request', {
          code: 'invalid_response',
        });
      }

      // 2. Poll long-running operation
      const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${apiKey}`;
      const startTime = Date.now();
      const timeoutMs = 300000; // 5 minute max

      while (Date.now() - startTime < timeoutMs) {
        if (ctx.signal?.aborted) {
          throw new ProviderError('Google Veo generation aborted', { code: 'aborted' });
        }

        // Wait 4 seconds between polls
        await new Promise((resolve) => setTimeout(resolve, 4000));

        const pollRes = await fetch(pollUrl, {
          headers: { 'Content-Type': 'application/json' },
          signal: ctx.signal,
        });

        if (!pollRes.ok) continue;

        const pollData = await pollRes.json();

        if (pollData.error) {
          throw new ProviderError(`Google Veo error: ${pollData.error.message || JSON.stringify(pollData.error)}`, {
            code: 'invalid_response',
          });
        }

        if (pollData.done) {
          const resp = pollData.response;
          const sample =
            resp?.generateVideoResponse?.generatedSamples?.[0] ||
            resp?.predictions?.[0] ||
            resp?.videos?.[0];

          const videoUri =
            sample?.video?.uri ||
            sample?.videoUrl ||
            sample?.video_uri ||
            sample?.uri;

          if (!videoUri) {
            // Check for base64 data
            const b64 = sample?.video?.bytesBase64Encoded;
            if (b64) {
              const dataUri = `data:video/mp4;base64,${b64}`;
              return {
                videoUrl: dataUri,
                durationSeconds,
                usage: { costUsd: 0.25 },
              };
            }

            throw new ProviderError('Google Veo completed but no video URI was returned', {
              code: 'invalid_response',
            });
          }

          return {
            videoUrl: videoUri,
            durationSeconds,
            usage: { costUsd: 0.25 },
          };
        }
      }

      throw new ProviderError('Google Veo video generation timed out after 5 minutes', {
        code: 'timeout',
      });
    } catch (err) {
      if (err instanceof ProviderError || err instanceof ConfigurationError) {
        throw err;
      }
      throw mapHttpOrSdkError(err, 'Google Veo video generation failed');
    }
  }
}

export const googleVeoVideo = new GoogleVeoVideoProvider();
