import type { ZodType } from 'zod';

export type ProviderKind = 'llm' | 'image' | 'tts' | 'video' | 'stock';

export interface Usage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  characters?: number;
}

export interface ProviderCallContext {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  options: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly kind: 'llm';
  readonly id: string;
  readonly requiresApiKey?: boolean;
  /** Accepts images in generateJson (used to check footage relevance). */
  readonly supportsVision?: boolean;
  generateText(
    req: { system?: string; prompt: string; maxTokens?: number; temperature?: number },
    ctx: ProviderCallContext,
  ): Promise<{ text: string; usage: Usage }>;
  generateJson<T>(
    req: { system?: string; prompt: string; schema: ZodType<T>; maxTokens?: number; images?: LlmImage[] },
    ctx: ProviderCallContext,
  ): Promise<{ data: T; usage: Usage }>;
}

/** An image passed to a vision-capable LLM, base64-encoded. */
export interface LlmImage {
  mimeType: string;
  data: string;
}

export interface ImageProvider {
  readonly kind: 'image';
  readonly id: string;
  readonly requiresApiKey?: boolean;
  generate(
    req: { prompt: string; width: number; height: number; seed?: number; negativePrompt?: string },
    ctx: ProviderCallContext,
  ): Promise<{ bytes: Uint8Array; mimeType: string; usage: Usage }>;
}

export interface SyncedVoice {
  id: string;
  name: string;
  sampleUrl?: string | null;
  tier?: string | null;
  category?: string | null;
  targetQuality?: string | null;
  trainingDuration?: string | null;
}

export interface TtsRequest {
  text: string;
  voiceId: string;
  speed?: number;
  format: 'mp3' | 'wav';
  /** Natural-language delivery direction ("calm, authoritative documentary narrator"); providers that can't use it ignore it. */
  direction?: string;
}

export interface TtsResult {
  bytes: Uint8Array;
  mimeType: string;
  durationMs?: number;
  usage: Usage;
  /** Timings of the words as spoken (seconds), when the provider reports them. */
  words?: Array<{ word: string; start: number; end: number }>;
}

export interface TTSProvider {
  readonly kind: 'tts';
  readonly id: string;
  readonly requiresApiKey?: boolean;
  /** How many beats may be voiced at once (default 1). Local engines on one CPU should stay at 1. */
  readonly maxConcurrency?: number;
  /** True when the provider uses TtsRequest.direction (so a changed direction should re-voice). */
  readonly supportsDirection?: boolean;
  synthesize(req: TtsRequest, ctx: ProviderCallContext): Promise<TtsResult>;
  listVoices?(ctx: ProviderCallContext): Promise<SyncedVoice[]>;
}

export interface StockVideoFile {
  url: string;
  width: number;
  height: number;
  size?: number;
  quality?: string;
}

export interface StockVideoCandidate {
  id: string | number;
  url: string;
  width: number;
  height: number;
  duration: number; // in seconds
  pageUrl?: string;
  attribution?: string;
  tags?: string;
  files?: StockVideoFile[];
  /** A still preview of the clip, for relevance checks before downloading. */
  thumbnailUrl?: string;
}

export interface StockProvider {
  readonly kind: 'stock';
  readonly id: string;
  readonly requiresApiKey: boolean;
  searchVideos(
    query: string,
    ctx: ProviderCallContext,
  ): Promise<StockVideoCandidate[]>;
  downloadVideo?(
    url: string,
    targetPath: string,
    ctx?: ProviderCallContext,
  ): Promise<string>;
}

export interface VideoProvider {
  readonly kind: 'video';
  readonly id: string;
  readonly requiresApiKey: boolean;
  generateVideo(
    req: {
      prompt: string;
      durationSeconds?: number;
      aspectRatio?: '16:9' | '9:16' | '1:1';
      model?: string;
      imageUrl?: string;
    },
    ctx: ProviderCallContext,
  ): Promise<{ videoUrl: string; durationSeconds?: number; usage?: Usage }>;
}

export type AnyProvider = LLMProvider | ImageProvider | TTSProvider | StockProvider | VideoProvider;

export type PipelineStage =
  | 'research'
  | 'script'
  | 'image'
  | 'visuals'
  | 'tts'
  | 'assembly'
  | 'thumbnail'
  | 'metadata';

export type JobStatus = 'queued' | 'running' | 'failed' | 'done' | 'cancelled';
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type UnitStatus = 'pending' | 'running' | 'done' | 'failed';
