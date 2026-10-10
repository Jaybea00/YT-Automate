import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { ProviderCallContext, SyncedVoice, TTSProvider, Usage } from '../types';

export class OpenAiCompatibleTtsProvider implements TTSProvider {
  readonly kind = 'tts' as const;
  readonly id: string;
  readonly requiresApiKey: boolean;

  constructor(id: string = 'openai-compatible', requiresApiKey: boolean = false) {
    this.id = id;
    this.requiresApiKey = requiresApiKey;
  }

  async synthesize(
    req: { text: string; voiceId: string; speed?: number; format: 'mp3' | 'wav' },
    ctx: ProviderCallContext,
  ): Promise<{ bytes: Uint8Array; mimeType: string; durationMs?: number; usage: Usage }> {
    const baseUrl = ctx.baseUrl || 'https://api.openai.com/v1';
    const url = `${baseUrl.replace(/\/+$/, '')}/audio/speech`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (ctx.apiKey) {
      headers.Authorization = `Bearer ${ctx.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: ctx.model || 'tts-1',
      input: req.text,
      voice: req.voiceId,
      response_format: req.format,
      ...ctx.options,
    };

    if (req.speed !== undefined) {
      body.speed = req.speed;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctx.signal,
      });

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // Ignore
        }
        throw mapHttpOrSdkError(
          {
            status: response.status,
            message: `TTS endpoint request failed: ${errorBody || response.statusText}`,
            headers: response.headers,
          },
          'TTS request failed',
        );
      }

      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const mimeType = req.format === 'wav' ? 'audio/wav' : 'audio/mpeg';

      const usage: Usage = {
        characters: req.text.length,
      };

      return {
        bytes,
        mimeType,
        usage,
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw mapHttpOrSdkError(error, 'TTS synthesis failed');
    }
  }

  async listVoices(
    ctx: ProviderCallContext,
  ): Promise<SyncedVoice[]> {
    const rawBase = (ctx.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const url = rawBase.endsWith('/v1')
      ? `${rawBase}/audio/voices`
      : `${rawBase}/v1/audio/voices`;

    try {
      const headers: Record<string, string> = {};
      if (ctx.apiKey) {
        headers.Authorization = `Bearer ${ctx.apiKey}`;
      }
      let response = await fetch(url, {
        method: 'GET',
        headers,
        signal: ctx.signal,
      });

      if (!response.ok && !rawBase.endsWith('/v1')) {
        response = await fetch(`${rawBase}/audio/voices`, {
          method: 'GET',
          headers,
          signal: ctx.signal,
        });
      }

      if (response.ok) {
        const data = (await response.json()) as {
          voices?: Array<
            | string
            | {
                id: string;
                name: string;
                target_quality?: string | null;
                training_duration?: string | null;
                overall_grade?: string | null;
              }
          >;
        };

        if (Array.isArray(data.voices)) {
          return data.voices.map((v) => {
            if (typeof v === 'string') {
              return {
                id: v,
                name: v,
                sampleUrl: null,
                tier: 'standard',
              };
            }
            return {
              id: v.id,
              name: v.name || v.id,
              sampleUrl: null,
              tier: v.overall_grade || v.target_quality || 'standard',
              targetQuality: v.target_quality || null,
              trainingDuration: v.training_duration || null,
            };
          });
        }
      }
    } catch {
      // Fallback
    }

    // Default OpenAI voices
    return [
      { id: 'alloy', name: 'Alloy', sampleUrl: null, tier: 'standard' },
      { id: 'echo', name: 'Echo', sampleUrl: null, tier: 'standard' },
      { id: 'fable', name: 'Fable', sampleUrl: null, tier: 'standard' },
      { id: 'onyx', name: 'Onyx', sampleUrl: null, tier: 'standard' },
      { id: 'nova', name: 'Nova', sampleUrl: null, tier: 'standard' },
      { id: 'shimmer', name: 'Shimmer', sampleUrl: null, tier: 'standard' },
    ];
  }
}

export const openAiCompatTts = new OpenAiCompatibleTtsProvider('openai-compatible', false);
export const openAiTts = new OpenAiCompatibleTtsProvider('openai', true);
