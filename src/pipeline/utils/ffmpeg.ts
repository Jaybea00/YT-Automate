import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export function getFfmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

export function getFfprobePath(): string {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

export { renderBeatScene, concatenateSceneClips } from '../assembly/assemble-beat';

/**
 * Verifies that ffmpeg and ffprobe are installed and executable on the host system.
 * Throws a clear error if either binary is missing or fails execution.
 */
export async function verifyFfmpegInstalled(): Promise<void> {
  if (process.env.SKIP_FFMPEG_CHECK === 'true' || process.env.SKIP_STARTUP_CHECKS === 'true') {
    console.warn('[Worker] Warning: SKIP_FFMPEG_CHECK is enabled. Skipping FFmpeg/ffprobe installation check.');
    return;
  }

  const ffmpegBin = getFfmpegPath();
  const ffprobeBin = getFfprobePath();

  try {
    await execFileAsync(ffmpegBin, ['-version'], { timeout: 5000 });
  } catch (err) {
    throw new Error(
      `Startup check failed: "${ffmpegBin}" is not installed or not executable on the system PATH. ` +
        `Install FFmpeg or set FFMPEG_PATH to its absolute binary path. (Error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }

  try {
    await execFileAsync(ffprobeBin, ['-version'], { timeout: 5000 });
  } catch (err) {
    throw new Error(
      `Startup check failed: "${ffprobeBin}" is not installed or not executable on the system PATH. ` +
        `Install FFmpeg/ffprobe or set FFPROBE_PATH to its absolute binary path. (Error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** Parses ffmpeg `silencedetect` output (stderr) into silence intervals in seconds. */
export function parseSilenceDetect(stderr: string, durationSec: number): Array<{ start: number; end: number }> {
  const silences: Array<{ start: number; end: number }> = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (start) open = Math.max(0, parseFloat(start[1]));
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (end && open !== null) {
      silences.push({ start: open, end: parseFloat(end[1]) });
      open = null;
    }
  }
  // A silence still open at the end of the file runs to the end
  if (open !== null) silences.push({ start: open, end: durationSec });
  return silences;
}

/**
 * Finds pauses in narration audio (default: below -35 dB for at least 120 ms).
 * Used to anchor estimated word timings to the real gaps between phrases.
 */
export async function detectSilences(
  filePath: string,
  durationSec: number,
  options: { noiseDb?: number; minSeconds?: number } = {},
): Promise<Array<{ start: number; end: number }>> {
  const { noiseDb = -35, minSeconds = 0.12 } = options;
  const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const { stderr } = await execFileAsync(getFfmpegPath(), [
    '-hide_banner',
    '-i',
    filePath,
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`,
    '-f',
    'null',
    nullOut,
  ]);
  return parseSilenceDetect(stderr, durationSec);
}

/**
 * Measures audio duration in milliseconds using ffprobe.
 * Fails with an Error if ffprobe is missing or output is invalid.
 * Never falls back to a made-up duration.
 */
export async function getAudioDurationMs(filePath: string): Promise<number> {
  const ffprobeBin = getFfprobePath();
  try {
    const { stdout } = await execFileAsync(ffprobeBin, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);

    const durationSeconds = Number.parseFloat(stdout.trim());
    if (Number.isNaN(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`ffprobe returned invalid duration: "${stdout.trim()}"`);
    }

    return Math.round(durationSeconds * 1000);
  } catch (error) {
    throw new Error(
      `Failed to measure audio duration with ffprobe for "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface AssemblySceneItem {
  imagePath: string;
  audioPath: string;
  durationMs?: number;
}

export interface AssemblyOptions {
  scenes: AssemblySceneItem[];
  outputPath: string;
  tempDir: string;
  fps?: number;
}

/**
 * Assembles scenes (image + audio) into a single cohesive video using FFmpeg.
 */
export async function assembleVideo(options: AssemblyOptions): Promise<string> {
  const { scenes, outputPath, tempDir, fps = 30 } = options;
  const ffmpegBin = getFfmpegPath();

  if (scenes.length === 0) {
    throw new Error('No scenes provided for video assembly');
  }

  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const sceneClips: string[] = [];

  // Generate intermediate clip for each scene
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const clipPath = path.join(tempDir, `scene_${i}.mp4`);

    // FFmpeg command to combine still image with audio stream
    const args = [
      '-y',
      '-loop',
      '1',
      '-i',
      scene.imagePath,
      '-i',
      scene.audioPath,
      '-c:v',
      'libx264',
      '-tune',
      'stillimage',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps),
      '-shortest',
      clipPath,
    ];

    try {
      await execFileAsync(ffmpegBin, args);
      sceneClips.push(clipPath);
    } catch (err) {
      throw new Error(
        `FFmpeg failed rendering scene clip ${i}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // If only 1 scene, move or copy
  if (sceneClips.length === 1) {
    await fs.copyFile(sceneClips[0], outputPath);
    return outputPath;
  }

  // Concatenate clips using concat demuxer
  const concatListPath = path.join(tempDir, 'concat_list.txt');
  const fileLines = sceneClips
    .map((clip) => `file '${clip.replace(/\\/g, '/')}'`)
    .join('\n');
  await fs.writeFile(concatListPath, fileLines, 'utf-8');

  const concatArgs = [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-c',
    'copy',
    outputPath,
  ];

  try {
    await execFileAsync(ffmpegBin, concatArgs);
  } catch (err) {
    throw new Error(
      `FFmpeg failed concatenating scene clips: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return outputPath;
}

/**
 * Converts / trims a WebM video to MP4 (1080p, 30fps) for an exact duration in seconds.
 */
export async function convertWebmToMp4(
  inputWebm: string,
  outputMp4: string,
  durationSeconds?: number,
): Promise<string> {
  const ffmpegBin = getFfmpegPath();
  await fs.mkdir(path.dirname(outputMp4), { recursive: true });

  const args = ['-y', '-i', inputWebm];
  if (durationSeconds !== undefined && durationSeconds > 0) {
    args.push('-t', durationSeconds.toFixed(3));
  }

  args.push(
    '-vf',
    'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-r',
    '30',
    outputMp4,
  );

  try {
    await execFileAsync(ffmpegBin, args);
    return outputMp4;
  } catch (err) {
    throw new Error(
      `FFmpeg failed converting WebM to MP4: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Measures video duration in milliseconds using ffprobe.
 */
export async function getVideoDurationMs(filePath: string): Promise<number> {
  return await getAudioDurationMs(filePath);
}
