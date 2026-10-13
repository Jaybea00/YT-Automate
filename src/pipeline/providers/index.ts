import { registerProvider } from './registry';
import { openAiLlm, openAiCompatLlm } from './llm/openai';
import { geminiLlm } from './llm/gemini';
import { anthropicLlm } from './llm/anthropic';
import { elevenLabsTts } from './tts/elevenlabs';
import { openAiCompatTts, openAiTts } from './tts/openai-compatible';
import { geminiTts } from './tts/gemini-tts';
import { openAiImage, openAiCompatImage } from './image/openai';
import { pollinationsImage } from './image/pollinations';
import { falVideo } from './video/fal';
import { googleVeoVideo } from './video/google-veo';
import { pixabayStock } from './stock/pixabay';

export * from './types';
export * from './errors';
export * from './registry';
export * from './error-mapper';
export { openAiLlm, openAiCompatLlm } from './llm/openai';
export { geminiLlm } from './llm/gemini';
export { anthropicLlm } from './llm/anthropic';
export { elevenLabsTts } from './tts/elevenlabs';
export { openAiCompatTts, openAiTts } from './tts/openai-compatible';
export { geminiTts, GeminiTtsProvider } from './tts/gemini-tts';
export { openAiImage, openAiCompatImage } from './image/openai';
export { pollinationsImage, PollinationsImageProvider } from './image/pollinations';
export { falVideo, FalVideoProvider } from './video/fal';
export { googleVeoVideo, GoogleVeoVideoProvider } from './video/google-veo';
export { pixabayStock, PixabayStockProvider } from './stock/pixabay';

// Default registration of standard built-in providers
export function registerDefaultProviders(): void {
  registerProvider('llm', 'openai', openAiLlm);
  registerProvider('llm', 'openai-compatible', openAiCompatLlm);
  registerProvider('llm', 'gemini', geminiLlm);
  registerProvider('llm', 'anthropic', anthropicLlm);
  registerProvider('llm', 'claude', anthropicLlm);
  registerProvider('tts', 'elevenlabs', elevenLabsTts);
  registerProvider('tts', 'openai-compatible', openAiCompatTts);
  registerProvider('tts', 'openai', openAiTts);
  registerProvider('tts', 'gemini-tts', geminiTts);
  registerProvider('image', 'openai', openAiImage);
  registerProvider('image', 'openai-compatible', openAiCompatImage);
  registerProvider('image', 'pollinations', pollinationsImage);
  registerProvider('video', 'fal', falVideo);
  registerProvider('video', 'google_veo', googleVeoVideo);
  registerProvider('stock', 'pixabay', pixabayStock);
}

registerDefaultProviders();

