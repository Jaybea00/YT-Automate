import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { ProviderCallContext, SyncedVoice, TTSProvider, TtsRequest, TtsResult, Usage } from '../types';
import { serverOptions } from './options';

interface ElevenLabsAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Groups ElevenLabs per-character timings into whitespace-separated words. */
export function charactersToWords(alignment: ElevenLabsAlignment): Array<{ word: string; start: number; end: number }> {
  const words: Array<{ word: string; start: number; end: number }> = [];
  let current: { word: string; start: number; end: number } | null = null;
  alignment.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (current) words.push(current);
      current = null;
      return;
    }
    const start = alignment.character_start_times_seconds[i];
    const end = alignment.character_end_times_seconds[i];
    if (current) {
      current.word += ch;
      current.end = end;
    } else {
      current = { word: ch, start, end };
    }
  });
  if (current) words.push(current);
  return words;
}

export class ElevenLabsTtsProvider implements TTSProvider {
  readonly kind = 'tts' as const;
  readonly id: string;
  readonly requiresApiKey = true;
  readonly maxConcurrency = 3;

  constructor(id: string = 'elevenlabs') {
    this.id = id;
  }

  async synthesize(req: TtsRequest, ctx: ProviderCallContext): Promise<TtsResult> {
    const baseUrl = ctx.baseUrl || 'https://api.elevenlabs.io';
    const outputFormat = req.format === 'wav' ? 'pcm_44100' : 'mp3_44100_128';
    // The with-timestamps variant returns the same audio as base64 plus per-character timings
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=${outputFormat}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'xi-api-key': ctx.apiKey,
    };

    const body: Record<string, unknown> = {
      text: req.text,
      model_id: ctx.model || 'eleven_multilingual_v2',
      ...serverOptions(ctx.options),
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

      const data = (await response.json()) as { audio_base64: string; alignment?: ElevenLabsAlignment | null };
      const bytes = new Uint8Array(Buffer.from(data.audio_base64, 'base64'));
      const mimeType = req.format === 'wav' ? 'audio/wav' : 'audio/mpeg';

      const usage: Usage = {
        characters: req.text.length,
      };

      return {
        bytes,
        mimeType,
        usage,
        words: data.alignment ? charactersToWords(data.alignment) : undefined,
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
