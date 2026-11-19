import { ProviderError } from '../errors';
import { mapHttpOrSdkError } from '../error-mapper';
import type { ProviderCallContext, SyncedVoice, TTSProvider, TtsRequest, TtsResult } from '../types';

/**
 * ai33.pro (OpenSpeaker): one API in front of many voice engines (ElevenLabs, MiniMax, Fish
 * Audio, Edge, Kokoro, Vbee and your own cloned voices). Voicing is a task: the text is sent,
 * the task is polled until it's done, then its audio is downloaded. Voice ids carry their engine
 * as a prefix ("elevenlabs_…", "minimax_…", "clone_…").
 *
 * Key: AI33_API_KEY (or the config's Vault secret). Options on the provider config:
 *   voiceProviders: engines whose voices "Sync voices" lists (default: elevenlabs, minimax, kokoro)
 */

const DEFAULT_BASE = 'https://api.ai33.pro';
const DEFAULT_SYNC_PROVIDERS = ['elevenlabs', 'minimax', 'kokoro'];
const POLL_MS = 2000;
const TIMEOUT_MS = 10 * 60_000;

interface Ai33Task {
  id?: string;
  status?: 'doing' | 'done' | 'error' | string;
  error_message?: string | null;
  metadata?: { audio_url?: string; json_url?: string; srt_url?: string };
}

type Word = { word: string; start: number; end: number };

/**
 * Word timings from the task's transcript file. The file's shape isn't documented, so the common
 * ones are read: a list of words, or segments holding words, with times in seconds or ms.
 */
export function parseAi33Transcript(data: unknown): Word[] | undefined {
  const out: Word[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    const word = typeof n.word === 'string' ? n.word : typeof n.text === 'string' && !Array.isArray(n.words) ? n.text : null;
    const start = Number(n.start ?? n.start_time ?? n.startTime ?? n.begin);
    const end = Number(n.end ?? n.end_time ?? n.endTime);
    if (word && word.trim() && !word.includes(' ') && Number.isFinite(start) && Number.isFinite(end)) {
      out.push({ word: word.trim(), start, end });
      return;
    }
    for (const key of ['words', 'segments', 'items', 'alignment', 'data', 'transcript']) if (key in n) visit(n[key]);
  };
  visit(data);
  if (out.length < 2) return undefined;
  // Times in milliseconds: anything past an hour per word list is not seconds
  const scale = out[out.length - 1].end > 3600 ? 1 / 1000 : 1;
  return out.map((w) => ({ word: w.word, start: Math.round(w.start * scale * 1000) / 1000, end: Math.round(w.end * scale * 1000) / 1000 })).sort((a, b) => a.start - b.start);
}

export class Ai33TtsProvider implements TTSProvider {
  readonly kind = 'tts' as const;
  readonly id = 'ai33';
  readonly requiresApiKey = true;
  /** A cloud service: a few beats at once is fine. */
  readonly maxConcurrency = 3;

  constructor(
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private base(ctx: ProviderCallContext) {
    return (ctx.baseUrl || DEFAULT_BASE).replace(/\/+$/, '').replace(/\/v[13]$/, '');
  }

  private async call<T>(url: string, init: RequestInit, ctx: ProviderCallContext, what: string): Promise<T> {
    const res = await this.fetcher(url, { ...init, headers: { 'xi-api-key': ctx.apiKey, ...(init.headers ?? {}) }, signal: ctx.signal });
    if (!res.ok) {
      throw mapHttpOrSdkError({ status: res.status, message: `${what} failed: ${(await res.text().catch(() => '')).slice(0, 300)}`, headers: res.headers }, `${what} failed`);
    }
    return (await res.json()) as T;
  }

  async synthesize(req: TtsRequest, ctx: ProviderCallContext): Promise<TtsResult> {
    const base = this.base(ctx);
    const form = new FormData();
    form.set('text', req.text);
    form.set('voice_id', req.voiceId);
    form.set('speed', String(Math.min(1.5, Math.max(0.5, req.speed ?? 1))));
    form.set('with_transcript', 'true');
    const started = await this.call<{ success?: boolean; task_id?: string; message?: string }>(`${base}/v3/text-to-speech`, { method: 'POST', body: form }, ctx, 'ai33 voicing');
    if (!started.task_id) throw new ProviderError(`ai33 did not start the voicing: ${started.message ?? 'no task id'}`, { code: 'invalid_response' });

    // The task runs on their side: poll until it's done
    const deadline = Date.now() + TIMEOUT_MS;
    let task: Ai33Task;
    for (;;) {
      task = await this.call<Ai33Task>(`${base}/v1/task/${encodeURIComponent(started.task_id)}`, { method: 'GET' }, ctx, 'ai33 task check');
      if (task.status === 'done') break;
      if (task.status === 'error') throw new ProviderError(`ai33 voicing failed: ${task.error_message || 'unknown error'}`, { code: 'unknown' });
      if (Date.now() > deadline) throw new ProviderError('ai33 voicing took longer than 10 minutes', { code: 'timeout' });
      await this.sleep(POLL_MS);
    }

    const audioUrl = task.metadata?.audio_url;
    if (!audioUrl) throw new ProviderError('ai33 finished but gave no audio', { code: 'invalid_response' });
    const audio = await this.fetcher(audioUrl, { signal: ctx.signal });
    if (!audio.ok) throw new ProviderError(`ai33 audio could not be downloaded (${audio.status})`, { code: 'unknown' });
    const bytes = new Uint8Array(await audio.arrayBuffer());

    let words: Word[] | undefined;
    if (task.metadata?.json_url) {
      try {
        const t = await this.fetcher(task.metadata.json_url, { signal: ctx.signal });
        if (t.ok) words = parseAi33Transcript(await t.json());
      } catch {
        // Timings are a bonus: without them they're estimated from the audio
      }
    }
    return { bytes, mimeType: 'audio/mpeg', usage: { characters: req.text.length }, ...(words ? { words } : {}) };
  }

  /** Voices from the engines in options.voiceProviders (first 100 of each). */
  async listVoices(ctx: ProviderCallContext): Promise<SyncedVoice[]> {
    const base = this.base(ctx);
    const engines = Array.isArray(ctx.options.voiceProviders) && ctx.options.voiceProviders.length ? (ctx.options.voiceProviders as string[]) : DEFAULT_SYNC_PROVIDERS;
    const voices: SyncedVoice[] = [];
    for (const engine of engines) {
      const data = await this.call<{ data?: Array<{ voice_id: string; name?: string; language?: string; gender?: string; preview_url?: string | null }> }>(
        `${base}/v3/voices?provider=${encodeURIComponent(engine)}&page_size=100`,
        { method: 'GET' },
        ctx,
        `ai33 ${engine} voice list`,
      );
      for (const v of data.data ?? []) {
        if (!v.voice_id) continue;
        const details = [engine, v.language, v.gender].filter(Boolean).join(' · ');
        voices.push({ id: v.voice_id, name: `${v.name || v.voice_id} (${details})`, sampleUrl: v.preview_url || null, tier: engine, category: v.language || null });
      }
    }
    return voices;
  }
}

export const ai33Tts = new Ai33TtsProvider();
