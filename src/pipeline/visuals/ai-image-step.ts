import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MediaCandidate } from './types';

export interface GenerateAiVisualOptions {
  prompt: string;
  text?: string;
  width?: number;
  height?: number;
  seed?: number;
}

/**
 * Enriches a user or beat prompt into a high-fidelity cinematic documentary image prompt.
 */
export function enrichAiPrompt(prompt: string, contextText?: string): string {
  let clean = prompt.trim();
  if (!clean && contextText) {
    clean = contextText.trim();
  }

  // Remove quotes or markdown artifacts
  clean = clean.replace(/^["']|["']$/g, '');

  // If already detailed, return as-is
  if (clean.length > 80 && (clean.includes('cinematic') || clean.includes('photo') || clean.includes('detailed'))) {
    return clean;
  }

  return `${clean}, cinematic documentary photograph, 16:9 aspect ratio, atmospheric lighting, photorealistic, 8k resolution, highly detailed`;
}

/**
 * Generates an AI image visual candidate.
 * Free, zero API key required via Pollinations Flux.
 */
export async function generateAiVisualCandidate(
  options: GenerateAiVisualOptions,
): Promise<MediaCandidate> {
  const { prompt, text, width = 1920, height = 1080 } = options;
  const enriched = enrichAiPrompt(prompt, text);
  const seed = options.seed ?? Math.floor(Math.random() * 1000000);

  // Directly construct URL descriptors so previews and downloads are lightweight
  const downloadUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(enriched)}?width=${width}&height=${height}&seed=${seed}&nologo=true`;
  const thumbUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(enriched)}?width=480&height=270&seed=${seed}&nologo=true`;

  return {
    id: `ai_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    provider: 'pollinations',
    mediaType: 'image',
    title: prompt.trim() || 'AI Generated Visual',
    downloadUrl,
    thumbnailUrl: thumbUrl,
    previewUrl: downloadUrl,
    width,
    height,
    attribution: 'AI Generated Visual (Flux.1)',
    license: 'own_work',
  };
}

/**
 * Downloads and writes an AI generated image directly to destination filepath.
 */
export async function downloadAndSaveAiImage(
  candidate: MediaCandidate,
  destinationPath: string,
): Promise<string> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  const url = candidate.downloadUrl;
  if (!url) {
    throw new Error('AI candidate is missing downloadUrl');
  }

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'YT-Automation/1.0',
      Accept: 'image/jpeg, image/png, image/*',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to download AI image: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length < 500) {
    throw new Error('Downloaded AI image is corrupt or empty');
  }

  await fs.writeFile(destinationPath, buffer);
  return destinationPath;
}
