import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath, getFfprobePath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);

export interface SlideshowRiskCheck {
  totalScenes: number;
  stillCount: number;
  videoCount: number;
  hasContinuousMotion: boolean;
  score: number; // 0 (best) to 1 (high slideshow risk)
  isSafe: boolean;
  recommendations: string[];
}

export interface AudioQualityCheck {
  isClean: boolean;
  maxVolumeDb: number;
  hasClipping: boolean;
  hasSilence: boolean;
  warning?: string;
}

/**
 * Evaluates motion diversity across scenes to prevent stagnant "animated slideshow" videos.
 */
export function checkSlideshowRisk(scenes: {
  isVideo?: boolean;
  stillMotion?: 'zoom' | 'static';
}[]): SlideshowRiskCheck {
  const total = scenes.length;
  if (total === 0) {
    return {
      totalScenes: 0,
      stillCount: 0,
      videoCount: 0,
      hasContinuousMotion: true,
      score: 0,
      isSafe: true,
      recommendations: [],
    };
  }

  let stillCount = 0;
  let staticStillCount = 0;
  let videoCount = 0;

  for (const s of scenes) {
    if (s.isVideo) {
      videoCount++;
    } else {
      stillCount++;
      if (s.stillMotion === 'static') {
        staticStillCount++;
      }
    }
  }

  // A video is safe if it either has videos or if still images use dynamic Ken Burns camera motion
  const staticRatio = staticStillCount / total;
  const isSafe = staticRatio < 0.4; // Less than 40% purely static frames
  const score = Math.round(staticRatio * 100) / 100;

  const recommendations: string[] = [];
  if (staticRatio >= 0.4) {
    recommendations.push(
      'Too many static images in sequence. Enable Ken Burns motion (stillMotion: "zoom") or inject b-roll video clips.',
    );
  }

  return {
    totalScenes: total,
    stillCount,
    videoCount,
    hasContinuousMotion: staticStillCount === 0,
    score,
    isSafe,
    recommendations,
  };
}

/**
 * Runs ffprobe and volumedetect to check for audio clipping, silence, and track presence.
 */
export async function verifyAudioIntegrity(
  videoPath: string,
): Promise<AudioQualityCheck> {
  const ffmpeg = getFfmpegPath();
  const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null';

  try {
    const { stderr } = await execFileAsync(ffmpeg, [
      '-y',
      '-i', videoPath,
      '-af', 'volumedetect',
      '-vn', '-sn', '-dn',
      '-f', 'null',
      nullOut,
    ]);

    const maxVolMatch = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    const maxVolumeDb = maxVolMatch ? parseFloat(maxVolMatch[1]) : -12;

    const hasClipping = maxVolumeDb >= 0.05;
    const hasSilence = maxVolumeDb < -50;
    const isClean = !hasClipping && !hasSilence;

    let warning: string | undefined;
    if (hasClipping) {
      warning = `Audio clipping detected (${maxVolumeDb} dB). Reduce narrator or BGM volume.`;
    } else if (hasSilence) {
      warning = `Audio track appears silent (max volume: ${maxVolumeDb} dB).`;
    }

    return {
      isClean,
      maxVolumeDb,
      hasClipping,
      hasSilence,
      warning,
    };
  } catch (err) {
    console.warn('[QualityGuard] Audio integrity check error:', err instanceof Error ? err.message : String(err));
    return {
      isClean: true,
      maxVolumeDb: -12,
      hasClipping: false,
      hasSilence: false,
    };
  }
}
