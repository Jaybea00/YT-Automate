import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MediaCandidate } from './types';
import { falVideo } from '../providers/video/fal';
import { googleVeoVideo } from '../providers/video/google-veo';
import { ConfigurationError } from '../providers/errors';

export interface GenerateAiVideoOptions {
  prompt: string;
  text?: string;
  model?: 'veo2' | 'kling' | 'minimax' | 'luma';
  aspectRatio?: '16:9' | '9:16' | '1:1';
  durationSeconds?: number;
  imageUrl?: string;
  provider?: 'google_veo' | 'fal';
}

/**
 * Generates an authentic AI motion video candidate (e.g. Google Veo 2, Kling, MiniMax).
 * Supports direct Google Veo API keys (GOOGLE_VEO_API_KEY, GEMINI_API_KEY) or Fal.ai (FAL_KEY).
 */
export async function generateAiMotionVideoCandidate(
  options: GenerateAiVideoOptions,
): Promise<MediaCandidate> {
  const { prompt, text, model = 'veo2', aspectRatio = '16:9', durationSeconds = 5, imageUrl } = options;
  const cleanPrompt = prompt.trim() || text?.trim() || 'Cinematic documentary motion footage';

  const hasGoogleKey = Boolean(
    process.env.GOOGLE_VEO_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY,
  );
  const hasFalKey = Boolean(process.env.FAL_KEY);

  if (!hasGoogleKey && !hasFalKey) {
    throw new ConfigurationError(
      'AI Video Generation is ready, but no API key was found. Please add either GOOGLE_VEO_API_KEY=... (or GEMINI_API_KEY) for direct Google Veo, or FAL_KEY=... in your .env file.',
    );
  }

  // Determine provider:
  // If user requested or has direct Google key and model is veo2, use direct Google Veo.
  // Otherwise use Fal.ai.
  const useGoogleDirect = options.provider === 'google_veo' || (hasGoogleKey && (model === 'veo2' || !hasFalKey));

  if (useGoogleDirect && hasGoogleKey) {
    const result = await googleVeoVideo.generateVideo({
      prompt: cleanPrompt,
      aspectRatio,
      durationSeconds,
      imageUrl,
    });

    return {
      id: `video_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      provider: 'google_veo',
      mediaType: 'video',
      title: cleanPrompt,
      downloadUrl: result.videoUrl,
      thumbnailUrl: result.videoUrl,
      duration: result.durationSeconds || durationSeconds,
      attribution: 'Google Veo 2 AI Motion Video',
      license: 'own_work',
    };
  }

  // Otherwise route through Fal
  const result = await falVideo.generateVideo({
    prompt: cleanPrompt,
    model,
    aspectRatio,
    durationSeconds,
    imageUrl,
  });

  return {
    id: `video_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    provider: 'fal',
    mediaType: 'video',
    title: cleanPrompt,
    downloadUrl: result.videoUrl,
    thumbnailUrl: result.videoUrl,
    duration: result.durationSeconds || durationSeconds,
    attribution: `AI Motion Video (${model.toUpperCase()})`,
    license: 'own_work',
  };
}


/**
 * Downloads the generated MP4 video directly to local filesystem.
 */
export async function downloadAndSaveAiVideo(
  videoUrl: string,
  destinationPath: string,
): Promise<string> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  const res = await fetch(videoUrl, {
    headers: {
      'User-Agent': 'YT-Automation/1.0',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to download AI generated video: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length < 1000) {
    throw new Error('Downloaded AI video file is corrupt or empty');
  }

  await fs.writeFile(destinationPath, buffer);
  return destinationPath;
}
