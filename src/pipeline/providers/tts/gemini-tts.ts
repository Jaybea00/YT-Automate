import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { ProviderCallContext, SyncedVoice, TTSProvider, TtsRequest, TtsResult } from '../types';

const DEFAULT_MODEL = 'gemini-3.8-flash-tts';
const DEFAULT_VOICE = 'Charon';
const SAMPLE_RATE = 24000;

/** Gemini's prebuilt voices and Google's one-word character for each. */
export const GEMINI_VOICES: Array<{ name: string; character: string }> = [
  { name: 'Zephyr', character: 'Bright' },
  { name: 'Puck', character: 'Upbeat' },
  { name: 'Charon', character: 'Informative' },
  { name: 'Kore', character: 'Firm' },
  { name: 'Fenrir', character: 'Excitable' },
  { name: 'Leda', character: 'Youthful' },
  { name: 'Orus', character: 'Firm' },
  { name: 'Aoede', character: 'Breezy' },
  { name: 'Callirrhoe', character: 'Easy-going' },
  { name: 'Autonoe', character: 'Bright' },
  { name: 'Enceladus', character: 'Breathy' },
  { name: 'Iapetus', character: 'Clear' },
  { name: 'Umbriel', character: 'Easy-going' },
  { name: 'Algieba', character: 'Smooth' },
  { name: 'Despina', character: 'Smooth' },
  { name: 'Erinome', character: 'Clear' },
  { name: 'Algenib', character: 'Gravelly' },
  { name: 'Rasalgethi', character: 'Informative' },
  { name: 'Laomedeia', character: 'Upbeat' },
  { name: 'Achernar', character: 'Soft' },
  { name: 'Alnilam', character: 'Firm' },
  { name: 'Schedar', character: 'Even' },
  { name: 'Gacrux', character: 'Mature' },
  { name: 'Pulcherrima', character: 'Forward' },
  { name: 'Achird', character: 'Friendly' },
  { name: 'Zubenelgenubi', character: 'Casual' },
  { name: 'Vindemiatrix', character: 'Gentle' },
  { name: 'Sadachbia', character: 'Lively' },
  { name: 'Sadaltager', character: 'Knowledgeable' },
  { name: 'Sulafat', character: 'Warm' },
];
const VOICE_NAMES = new Set(GEMINI_VOICES.map((v) => v.name.toLowerCase()));

/** Wraps raw 16-bit mono PCM in a WAV header so ffmpeg and browsers can play it. */
export function pcmToWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

/**
 * Plain narration with no instruction reads at ~2.0-2.2 words/sec, matching the pace scripts are
 * planned around. Measured on gemini-3.8-flash-tts: any instruction slows it down, even "brisk"
 * (1.65 w/s) or an explicit "160 words per minute" (1.36 w/s); a style direction plus pace note
 * dropped to 0.80 w/s. So direction is only prepended when explicitly supplied.
 */
export function buildGeminiTtsPrompt(text: string, direction?: string): string {
  return direction ? `${direction}\n${text}` : text;
}

interface GoogleErrorBody {
  error?: {
    message?: string;
    details?: Array<{ violations?: Array<{ quotaId?: string; quotaValue?: string }>; retryDelay?: string }>;
  };
}

/**
 * Turns a 429 into the right retry behaviour: a per-day quota can't recover by waiting minutes,
 * so it fails at once with guidance; a per-minute limit waits the delay Google specifies.
 */
export function classifyGeminiQuotaError(body: GoogleErrorBody, model: string): ProviderError {
  const details = body.error?.details ?? [];
  const violation = details.flatMap((d) => d.violations ?? []).find((v) => v.quotaId);
  const retryDelaySec = Number(details.find((d) => d.retryDelay)?.retryDelay?.replace(/s$/, ''));

  if (violation?.quotaId && /PerDay/i.test(violation.quotaId)) {
    const tier = /FreeTier/i.test(violation.quotaId) ? 'free tier' : 'current plan';
    return new ProviderError(
      `Gemini voice quota for today is used up (${tier}: ${violation.quotaValue ?? '?'} requests per day for ${model}). ` +
        'Enable billing in Google AI Studio, or pick a Kokoro or ElevenLabs narrator for this video.',
      { code: 'quota_exhausted' },
    );
  }
  return new ProviderError(`Gemini TTS rate limited: ${body.error?.message?.slice(0, 200) ?? '429'}`, {
    code: 'rate_limit',
    retryAfterMs: Number.isFinite(retryDelaySec) && retryDelaySec > 0 ? retryDelaySec * 1000 : undefined,
  });
}

/**
 * Gemini text-to-speech (generateContent with audio output). Runs in Google's cloud, takes
 * natural-language delivery direction, and returns 24 kHz PCM which is wrapped as WAV.
 * It reports no word timings; those are estimated from the audio by the voicing step.
 */
export class GeminiTtsProvider implements TTSProvider {
  readonly kind = 'tts' as const;
  readonly id = 'gemini-tts';
  readonly requiresApiKey = true;
  readonly maxConcurrency = 3;
  readonly supportsDirection = true;

  async synthesize(req: TtsRequest, ctx: ProviderCallContext): Promise<TtsResult> {
    const model = ctx.model || DEFAULT_MODEL;
    const voiceName = VOICE_NAMES.has(req.voiceId.toLowerCase()) ? req.voiceId : DEFAULT_VOICE;
    const baseUrl = (ctx.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

    try {
      const response = await fetch(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildGeminiTtsPrompt(req.text, req.direction) }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
        }),
        signal: ctx.signal,
      });

      if (response.status === 429) {
        const body = (await response.json().catch(() => ({}))) as GoogleErrorBody;
        throw classifyGeminiQuotaError(body, model);
      }
      if (!response.ok) {
        throw mapHttpOrSdkError(
          {
            status: response.status,
            message: `Gemini TTS request failed: ${(await response.text().catch(() => '')).slice(0, 500)}`,
            headers: response.headers,
          },
          'Gemini TTS request failed',
        );
      }

      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
      };
      const audio = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
      if (!audio?.data) {
        throw new ProviderError('Gemini TTS returned no audio', { code: 'invalid_response' });
      }

      const rate = Number(audio.mimeType?.match(/rate=(\d+)/)?.[1]) || SAMPLE_RATE;
      const pcm = new Uint8Array(Buffer.from(audio.data, 'base64'));
      return {
        bytes: pcmToWav(pcm, rate),
        mimeType: 'audio/wav',
        durationMs: Math.round((pcm.byteLength / 2 / rate) * 1000),
        usage: { characters: req.text.length },
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw mapHttpOrSdkError(error, 'Gemini TTS synthesis failed');
    }
  }

  async listVoices(): Promise<SyncedVoice[]> {
    return GEMINI_VOICES.map((v) => ({ id: v.name, name: `${v.name} (${v.character})`, sampleUrl: null, tier: v.character }));
  }
}

export const geminiTts = new GeminiTtsProvider();
