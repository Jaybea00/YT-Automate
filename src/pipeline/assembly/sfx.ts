import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);

export const PRESET_SFX = [
  { id: 'whoosh', name: 'Fast Air Whoosh', icon: '💨', description: 'Dynamic, crisp transition whoosh for modern edits' },
  { id: 'swoosh', name: 'Deep Swoosh', icon: '🌊', description: 'Rich cinematic low-end whoosh for dramatic scene changes' },
  { id: 'click', name: 'Tech Click', icon: '🖱️', description: 'Crisp tactile pop / click, perfect for charts & tech data' },
  { id: 'chime', name: 'Soft Chime', icon: '🔔', description: 'Subtle acoustic bell chime for reveals & key takeaways' },
  { id: 'none', name: 'None (Silent)', icon: '🚫', description: 'No transition sound effects' },
] as const;

export type PresetSfxId = (typeof PRESET_SFX)[number]['id'];

/**
 * Ensures that built-in preset SFX audio files exist on disk.
 * Uses deterministic FFmpeg audio synthesis so it operates 100% offline.
 */
export async function ensureDefaultSfxPresets(): Promise<void> {
  const presetsDir = path.join(process.cwd(), 'storage', 'sfx', 'presets');
  await fs.mkdir(presetsDir, { recursive: true });

  const ffmpegBin = getFfmpegPath();

  const presetsToEnsure = [
    {
      fileName: 'whoosh.mp3',
      filter:
        'anoisesrc=d=0.4:c=white:r=48000,bandpass=f=800:w=600,afade=t=in:st=0:d=0.15,afade=t=out:st=0.15:d=0.25,volume=0.4',
    },
    {
      fileName: 'swoosh.mp3',
      filter:
        'anoisesrc=d=0.5:c=pink:r=48000,lowpass=f=600,afade=t=in:st=0:d=0.2,afade=t=out:st=0.2:d=0.3,volume=0.5',
    },
    {
      fileName: 'click.mp3',
      filter:
        'sine=f=1200:d=0.08:r=48000,afade=t=in:st=0:d=0.01,afade=t=out:st=0.01:d=0.07,volume=0.35',
    },
    {
      fileName: 'chime.mp3',
      filter:
        'sine=f=880:d=0.5:r=48000,afade=t=in:st=0:d=0.02,afade=t=out:st=0.05:d=0.45,volume=0.25',
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
          '-c:a',
          'libmp3lame',
          '-b:a',
          '192k',
          targetFile,
        ]);
      } catch (err) {
        console.warn(`[SFX] Failed generating synthesis preset for ${p.fileName}:`, err);
      }
    }
  }
}

/**
 * Resolves the absolute filesystem path for an SFX preset track.
 * Returns null if track is "none" or file cannot be resolved.
 */
export async function resolveSfxPath(trackId: string): Promise<string | null> {
  if (!trackId || trackId === 'none') {
    return null;
  }

  await ensureDefaultSfxPresets().catch(() => {});

  const presetFile = path.join(process.cwd(), 'storage', 'sfx', 'presets', `${trackId}.mp3`);
  const exists = await fs
    .stat(presetFile)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);

  if (exists) {
    return presetFile;
  }

  return null;
}
