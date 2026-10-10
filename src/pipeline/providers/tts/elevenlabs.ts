import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { ProviderCallContext, SyncedVoice, TTSProvider, Usage } from '../types';

export class ElevenLabsTtsProvider implements TTSProvider {
  readonly kind = 'tts' as const;
  readonly id: string;
  readonly requiresApiKey = true;

  constructor(id: string = 'elevenlabs') {
    this.id = id;
  }

  async synthesize(
    req: { text: string; voiceId: string; speed?: number; format: 'mp3' | 'wav' },
    ctx: ProviderCallContext,
  ): Promise<{ bytes: Uint8Array; mimeType: string; durationMs?: number; usage: Usage }> {
    const baseUrl = ctx.baseUrl || 'https://api.elevenlabs.io';
    const outputFormat = req.format === 'wav' ? 'pcm_44100' : 'mp3_44100_128';
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}?output_format=${outputFormat}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'xi-api-key': ctx.apiKey,
      Accept: req.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    };

    const body: Record<string, unknown> = {
      text: req.text,
      model_id: ctx.model || 'eleven_multilingual_v2',
      ...ctx.options,
    };

    if (req.speed !== undefined) {
      const voiceSettings = (body.voice_settings as Record<string, unknown>) || {};
      voiceSettings.speed = req.speed;
      body.voice_settings = voiceSettings;
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
            message: `ElevenLabs TTS request failed: ${errorBody || response.statusText}`,
            headers: response.headers,
          },
          'ElevenLabs TTS request failed',
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
      throw mapHttpOrSdkError(error, 'ElevenLabs synthesis failed');
    }
  }

  async listVoices(
    ctx: ProviderCallContext,
  ): Promise<SyncedVoice[]> {
    const baseUrl = ctx.baseUrl || 'https://api.elevenlabs.io';
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/voices`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'xi-api-key': ctx.apiKey,
        },
        signal: ctx.signal,
      });

      if (!response.ok) {
        throw mapHttpOrSdkError({
          status: response.status,
          message: `Failed to list ElevenLabs voices: ${response.statusText}`,
          headers: response.headers,
        });
      }

      const data = (await response.json()) as {
        voices?: Array<{
          voice_id: string;
          name: string;
          preview_url?: string | null;
          category?: string | null;
        }>;
      };
      return (data.voices || []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        sampleUrl: v.preview_url || null,
        tier: v.category || null,
        category: v.category || null,
      }));
    } catch (error) {
      throw mapHttpOrSdkError(error, 'Failed to list voices');
    }
  }
}

export const elevenLabsTts = new ElevenLabsTtsProvider('elevenlabs');
