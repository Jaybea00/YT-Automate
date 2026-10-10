import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);

export interface ApplyBgmOptions {
  videoPath: string;
  bgmPath: string;
  outputPath: string;
  volume?: number; // baseline BGM volume, default 0.20 (20%)
  duckingThreshold?: number; // voice threshold to trigger ducking, default 0.08
  duckingRatio?: number; // compression ratio when voice speaks, default 4
  attackMs?: number; // ducking attack time in ms, default 50
  releaseMs?: number; // ducking release time in ms, default 400
}

export const PRESET_TRACKS = [
  { id: 'lofi', name: 'Chill Lo-Fi', description: 'Warm mellow beats, perfect for explainers & essays' },
  { id: 'ambient', name: 'Cinematic Ambient', description: 'Spacious synthesizer pads for storytelling & deep dives' },
  { id: 'tech', name: 'Modern Tech & Corporate', description: 'Crisp, upbeat acoustic-digital rhythm for tutorials' },
  { id: 'none', name: 'None (Voice Only)', description: 'Narration voiceover without background music' },
] as const;

export type PresetTrackId = (typeof PRESET_TRACKS)[number]['id'];

/**
 * Ensures that built-in preset audio tracks exist on disk.
 * Generates pleasant ambient audio loops using FFmpeg synthesis if they don't exist,
 * guaranteeing offline zero-dependency operation.
 */
export async function ensureDefaultBgmPresets(): Promise<void> {
  const presetsDir = path.join(process.cwd(), 'storage', 'bgm', 'presets');
  await fs.mkdir(presetsDir, { recursive: true });

  const ffmpegBin = getFfmpegPath();

  const presetsToEnsure = [
    {
      fileName: 'lofi.mp3',
      filter:
        'sine=frequency=220:sample_rate=48000,volume=0.3[s1];sine=frequency=330:sample_rate=48000,volume=0.2[s2];sine=frequency=440:sample_rate=48000,volume=0.15[s3];sine=frequency=550:sample_rate=48000,volume=0.1[s4];[s1][s2][s3][s4]amix=inputs=4:duration=first,lowpass=f=2000,tremolo=f=0.5:d=0.3',
    },
    {
      fileName: 'ambient.mp3',
      filter:
        'sine=frequency=130.81:sample_rate=48000,volume=0.3[s1];sine=frequency=196.00:sample_rate=48000,volume=0.25[s2];sine=frequency=261.63:sample_rate=48000,volume=0.2[s3];sine=frequency=392.00:sample_rate=48000,volume=0.15[s4];[s1][s2][s3][s4]amix=inputs=4:duration=first,lowpass=f=1200,flanger=delay=5:depth=2:speed=0.2',
    },
    {
      fileName: 'tech.mp3',
      filter:
        'sine=frequency=261.63:sample_rate=48000,volume=0.25[s1];sine=frequency=329.63:sample_rate=48000,volume=0.2[s2];sine=frequency=392.00:sample_rate=48000,volume=0.2[s3];sine=frequency=523.25:sample_rate=48000,volume=0.15[s4];[s1][s2][s3][s4]amix=inputs=4:duration=first,highpass=f=200,lowpass=f=4000',
    },
  ];

  for (const p of presetsToEnsure) {
    const targetFile = path.join(presetsDir, p.fileName);
    const exists = await fs
      .stat(targetFile)
      .then((s) => s.isFile() && s.size > 0)
      .catch(() => false);

    if (!exists) {
      try {
        await execFileAsync(ffmpegBin, [
          '-y',
          '-f',
          'lavfi',
          '-i',
          p.filter,
          '-t',
          '15.0',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '192k',
          targetFile,
        ]);
      } catch (err) {
        console.warn(`[BGM] Warning: Failed to generate default preset ${p.fileName}:`, err);
      }
    }
  }
}

/**
 * Resolves the file path for a requested BGM track:
 * - Checks preset tracks in storage/bgm/presets/<track>.mp3
 * - Checks custom uploaded video track in storage/bgm/<videoId>/custom.<ext>
 * - Returns null if track is 'none' or not found.
 */
export async function resolveBgmTrackPath(options: {
  track?: string | null;
  customUrl?: string | null;
  videoId?: string | null;
}): Promise<string | null> {
  const { track = 'lofi', customUrl, videoId } = options;

  if (!track || track === 'none') {
    return null;
  }

  // 1. If custom track specified or uploaded for this video
  if (track === 'custom' || customUrl) {
    if (customUrl) {
      const diskPath = path.isAbsolute(customUrl)
        ? customUrl
        : path.join(process.cwd(), customUrl);
      const exists = await fs
        .stat(diskPath)
        .then((s) => s.isFile() && s.size > 0)
        .catch(() => false);
      if (exists) return diskPath;
    }

    if (videoId) {
      const customDir = path.join(process.cwd(), 'storage', 'bgm', videoId);
      try {
        const files = await fs.readdir(customDir);
        const match = files.find((f) => f.startsWith('custom.'));
        if (match) return path.join(customDir, match);
      } catch {
        // Directory doesn't exist yet
      }
    }
  }

  // 2. Preset track lookup
  await ensureDefaultBgmPresets();
  const presetsDir = path.join(process.cwd(), 'storage', 'bgm', 'presets');
  const presetFile = path.join(presetsDir, `${track}.mp3`);

  const exists = await fs
    .stat(presetFile)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);

  if (exists) {
    return presetFile;
  }

  // Fallback to lofi preset if available
  const lofiFallback = path.join(presetsDir, 'lofi.mp3');
  const lofiExists = await fs
    .stat(lofiFallback)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);

  return lofiExists ? lofiFallback : null;
}

/**
 * Mixes background music under voice narration using real-time sidechain ducking:
 * - When voice speaks, BGM volume smoothly attenuates.
 * - During natural pauses between beats, BGM swells back up to baseline volume.
 * - Video stream is copied losslessly with `-c:v copy` (zero quality loss, ultra fast).
 */
export async function applyBackgroundMusic(options: ApplyBgmOptions): Promise<string> {
  const {
    videoPath,
    bgmPath,
    outputPath,
    volume = 0.2,
    duckingThreshold = 0.08,
    duckingRatio = 4,
    attackMs = 50,
    releaseMs = 400,
  } = options;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const ffmpegBin = getFfmpegPath();

  // Clamp volume between 0.02 and 0.80
  const safeVolume = Math.max(0.02, Math.min(0.8, volume));

  // sidechaincompress: voice signal [0:a] ducks background music [bgm]
  const filterGraph = [
    `[1:a]volume=${safeVolume.toFixed(2)}[bgm]`,
    `[bgm][0:a]sidechaincompress=threshold=${duckingThreshold}:ratio=${duckingRatio}:attack=${attackMs}:release=${releaseMs}[ducked_bgm]`,
    `[0:a][ducked_bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
  ].join(';');

  const args = [
    '-y',
    '-i',
    videoPath,
    '-stream_loop',
    '-1',
    '-i',
    bgmPath,
    '-filter_complex',
    filterGraph,
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    outputPath,
  ];

  try {
    await execFileAsync(ffmpegBin, args);
    return outputPath;
  } catch (err) {
    throw new Error(
      `FFmpeg failed applying background music with auto-ducking: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
