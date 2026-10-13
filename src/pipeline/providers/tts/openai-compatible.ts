import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { ProviderCallContext, SyncedVoice, TTSProvider, TtsRequest, TtsResult, Usage } from '../types';
import { serverOptions } from './options';

interface CaptionedSpeechResponse {
  audio: string;
  timestamps?: Array<{ word: string; start_time: number; end_time: number }> | null;
}

export class OpenAiCompatibleTtsProvider implements TTSProvider {
  readonly kind = 'tts' as const;
  readonly id: string;
  readonly requiresApiKey: boolean;
  /** Base URLs whose server has no /dev/captioned_speech (learned on first 404). */
  private readonly noCaptionedSpeech = new Set<string>();

  constructor(id: string = 'openai-compatible', requiresApiKey: boolean = false) {
    this.id = id;
    this.requiresApiKey = requiresApiKey;
  }

  /**
   * Kokoro-FastAPI serves /dev/captioned_speech next to /v1/audio/speech: identical audio plus
   * word timestamps at no extra cost. Used for any self-hosted base URL unless the binding sets
   * options.wordTimestamps = false; servers without it fall back to plain speech once.
   */
  private async synthesizeCaptioned(
    req: TtsRequest,
    ctx: ProviderCallContext,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<TtsResult | null> {
    const baseUrl = ctx.baseUrl || '';
    if (!baseUrl || /api\.openai\.com/.test(baseUrl) || ctx.options?.wordTimestamps === false) return null;
    if (this.noCaptionedSpeech.has(baseUrl)) return null;

    const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const response = await fetch(`${root}/dev/captioned_speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: false, return_timestamps: true }),
      signal: ctx.signal,
    });
    if (response.status === 404 || response.status === 405) {
      this.noCaptionedSpeech.add(baseUrl);
      return null;
    }
    if (!response.ok) {
      throw mapHttpOrSdkError(
        { status: response.status, message: `Captioned speech failed: ${await response.text().catch(() => '')}`, headers: response.headers },
        'TTS request failed',
      );
    }

    const data = (await response.json()) as CaptionedSpeechResponse;
    return {
      bytes: new Uint8Array(Buffer.from(data.audio, 'base64')),
      mimeType: req.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
      usage: { characters: req.text.length },
      words: (data.timestamps ?? []).map((t) => ({ word: t.word, start: Math.max(0, t.start_time), end: t.end_time })),
    };
  }

  async synthesize(req: TtsRequest, ctx: ProviderCallContext): Promise<TtsResult> {
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
      ...serverOptions(ctx.options),
    };

    if (req.speed !== undefined) {
      body.speed = req.speed;
    }

    try {
      const captioned = await this.synthesizeCaptioned(req, ctx, body, headers);
      if (captioned) return captioned;

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

      return { bytes, mimeType, usage };
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
