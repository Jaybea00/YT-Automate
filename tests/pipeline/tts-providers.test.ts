import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleTtsProvider } from '../../src/pipeline/providers/tts/openai-compatible.ts';
import { charactersToWords } from '../../src/pipeline/providers/tts/elevenlabs.ts';
import {
  GeminiTtsProvider,
  buildGeminiTtsPrompt,
  classifyGeminiQuotaError,
  pcmToWav,
} from '../../src/pipeline/providers/tts/gemini-tts.ts';
import { getRetryDecision } from '../../src/pipeline/providers/errors.ts';

const realFetch = globalThis.fetch;

describe('Kokoro captioned speech', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('uses /dev/captioned_speech for word timestamps and keeps pipeline options off the wire', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          audio: Buffer.from([1, 2, 3]).toString('base64'),
          audio_format: 'audio/mpeg',
          timestamps: [
            { word: 'Hello', start_time: -0.01, end_time: 0.4 },
            { word: 'world', start_time: 0.4, end_time: 0.9 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const provider = new OpenAiCompatibleTtsProvider();
    const result = await provider.synthesize(
      { text: 'Hello world', voiceId: 'bm_george', format: 'mp3' },
      { apiKey: '', baseUrl: 'http://localhost:8880/v1', model: 'kokoro', options: { speed: 1.05, wordTimestamps: true } },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:8880/dev/captioned_speech');
    assert.equal(calls[0].body.stream, false);
    assert.equal(calls[0].body.speed, 1.05);
    assert.ok(!('wordTimestamps' in calls[0].body));
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3]);
    assert.deepEqual(result.words, [
      { word: 'Hello', start: 0, end: 0.4 },
      { word: 'world', start: 0.4, end: 0.9 },
    ]);
  });

  it('never tries captioned speech against OpenAI itself', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(new Uint8Array([9]), { status: 200 });
    }) as typeof fetch;

    const result = await new OpenAiCompatibleTtsProvider('openai', true).synthesize(
      { text: 'Hi', voiceId: 'alloy', format: 'mp3' },
      { apiKey: 'k', baseUrl: 'https://api.openai.com/v1' },
    );
    assert.deepEqual(urls, ['https://api.openai.com/v1/audio/speech']);
    assert.equal(result.words, undefined);
  });
});

describe('Gemini TTS', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('wraps 24 kHz PCM in a valid WAV header', () => {
    const wav = Buffer.from(pcmToWav(new Uint8Array(48000)));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.readUInt32LE(40), 48000);
    assert.equal(wav.byteLength, 48044);
  });

  it('sends plain narration unless a direction is given', () => {
    assert.equal(buildGeminiTtsPrompt('Black Tuesday.'), 'Black Tuesday.');
    assert.equal(buildGeminiTtsPrompt('Black Tuesday.', 'Tense.'), 'Tense.\nBlack Tuesday.');
  });

  it('fails fast on a daily quota and waits on a per-minute one', () => {
    // Shape of the real error Google returned for this key
    const daily = classifyGeminiQuotaError(
      {
        error: {
          message: 'You exceeded your current quota',
          details: [
            { violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '10' }] },
            { retryDelay: '27430s' },
          ],
        },
      },
      'gemini-3.8-flash-tts',
    );
    assert.equal(daily.code, 'quota_exhausted');
    assert.match(daily.message, /10 requests per day/);
    assert.equal(getRetryDecision(daily, 1, 3).retry, false);

    const perMinute = classifyGeminiQuotaError(
      { error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] }, { retryDelay: '21s' }] } },
      'gemini-3.8-flash-tts',
    );
    assert.equal(perMinute.code, 'rate_limit');
    assert.equal(perMinute.retryAfterMs, 21000);
    assert.equal(getRetryDecision(perMinute, 1, 3).delayMs, 21000);
  });

  it('returns WAV audio with its measured duration and the requested voice', async () => {
    let sent: any = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(24000 * 2 * 2).toString('base64') } }] } }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await new GeminiTtsProvider().synthesize(
      { text: 'Hello.', voiceId: 'Kore', format: 'mp3' },
      { apiKey: 'k', model: 'gemini-3.8-flash-tts' },
    );
    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(result.durationMs, 2000);
    assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.equal(sent.contents[0].parts[0].text, 'Hello.');

    await new GeminiTtsProvider().synthesize({ text: 'Hi.', voiceId: 'alloy', format: 'mp3' }, { apiKey: 'k' });
    assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon', 'unknown voices fall back to Charon');
  });
});

describe('ElevenLabs alignment', () => {
  it('groups per-character timings into words', () => {
    const text = 'Black Tuesday';
    const chars = text.split('');
    const words = charactersToWords({
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => i * 0.1),
      character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
    });
    assert.deepEqual(
      words.map((w) => [w.word, Math.round(w.start * 10) / 10, Math.round(w.end * 10) / 10]),
      [
        ['Black', 0, 0.5],
        ['Tuesday', 0.6, 1.3],
      ],
    );
  });
});
