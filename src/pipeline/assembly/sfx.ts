import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);

export const PRESET_SFX = [
  { id: 'smart', name: 'Smart Sound Design', icon: '🎚️', description: 'Effects placed by what is on screen: impacts on big numbers, ticks on charts, pings on maps, paper on newspapers' },
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

  // The "smart" preset's library and its preview demo
  await ensureSoundLibrary();
}

// --------------------------------------------------------------------------
// Sound library for smart sound design
// --------------------------------------------------------------------------

/**
 * Designed effects, synthesised offline (no licences, identical on every machine). Each is
 * peak-normalised when built, so how loud it plays is decided in one place: at the mix.
 */
export const SOUND_LIBRARY = {
  whoosh: 'anoisesrc=d=0.6:c=pink:r=48000:a=0.6,bandpass=f=900:w=1400,afade=t=in:st=0:d=0.3:curve=qsin,afade=t=out:st=0.3:d=0.3:curve=qsin',
  swoosh: 'anoisesrc=d=0.9:c=brown:r=48000:a=0.8,lowpass=f=700,highpass=f=60,afade=t=in:st=0:d=0.45:curve=qsin,afade=t=out:st=0.45:d=0.45:curve=qsin',
  impact: "aevalsrc='0.9*sin(2*PI*(70*t-40*t*t))*exp(-5*t)+0.35*(random(0)*2-1)*exp(-60*t)':s=48000:d=0.9,lowpass=f=3000",
  tick: "aevalsrc='0.6*sin(2*PI*1100*t)*exp(-55*t)':s=48000:d=0.12",
  ping: "aevalsrc='0.45*(sin(2*PI*1320*t)+0.4*sin(2*PI*2640*t))*exp(-7*t)*(1-exp(-400*t))':s=48000:d=0.7",
  paper: "aevalsrc='(random(0)*2-1)*(0.25+0.75*pow(abs(sin(2*PI*9*t+3*sin(2*PI*2.3*t))),6))*exp(-2.2*t)*0.7':s=48000:d=0.9,highpass=f=1800,lowpass=f=9000",
  key: "aevalsrc='0.5*(random(0)*2-1)*exp(-180*t)+0.3*sin(2*PI*2200*t)*exp(-120*t)':s=48000:d=0.05,highpass=f=1000",
  chime: "aevalsrc='0.22*(sin(2*PI*880*t)+0.6*sin(2*PI*1318.5*t)+0.4*sin(2*PI*1760*t)+0.2*sin(2*PI*2637*t))*exp(-2.5*t)*(1-exp(-200*t))':s=48000:d=1.6,aecho=0.8:0.6:60|120:0.3|0.2",
  riser: "aevalsrc='0.25*sin(2*PI*(200*t+300*t*t))*pow(t/1.4,2)+0.2*(random(0)*2-1)*pow(t/1.4,3)':s=48000:d=1.4,highpass=f=150,lowpass=f=6000,afade=t=out:st=1.35:d=0.05",
} as const;

export type SoundId = keyof typeof SOUND_LIBRARY;
export const SOUND_IDS = Object.keys(SOUND_LIBRARY) as SoundId[];

const LIBRARY_PEAK_DB = -3;
const libraryDir = () => path.join(process.cwd(), 'storage', 'sfx', 'library');
export const soundPath = (id: SoundId) => path.join(libraryDir(), `${id}.wav`);

async function peakDb(file: string): Promise<number> {
  const { stderr } = await execFileAsync(getFfmpegPath(), ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = stderr.match(/max_volume: (-?[\d.]+) dB/);
  return m ? Number.parseFloat(m[1]) : 0;
}

/** Builds any missing library sounds (peak-normalised), and the "smart" preview for the settings page. */
export async function ensureSoundLibrary(): Promise<void> {
  await fs.mkdir(libraryDir(), { recursive: true });
  const ffmpegBin = getFfmpegPath();
  for (const id of SOUND_IDS) {
    const target = soundPath(id);
    if (await fs.stat(target).then((s) => s.size > 0).catch(() => false)) continue;
    const raw = `${target}.raw.wav`;
    try {
      await execFileAsync(ffmpegBin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', SOUND_LIBRARY[id], '-ac', '1', '-ar', '48000', raw]);
      const gain = LIBRARY_PEAK_DB - (await peakDb(raw));
      await execFileAsync(ffmpegBin, ['-y', '-v', 'error', '-i', raw, '-af', `volume=${gain.toFixed(2)}dB`, '-ac', '1', '-ar', '48000', target]);
    } catch (err) {
      console.warn(`[SFX] Could not build library sound "${id}":`, err);
    } finally {
      await fs.unlink(raw).catch(() => {});
    }
  }

  // A short demo of the palette, so "Smart" can be previewed like the other presets
  const preview = path.join(process.cwd(), 'storage', 'sfx', 'presets', 'smart.mp3');
  if (!(await fs.stat(preview).then((s) => s.size > 0).catch(() => false))) {
    const demo: SoundId[] = ['whoosh', 'impact', 'tick', 'tick', 'ping', 'paper', 'chime'];
    const inputs = demo.flatMap((id) => ['-i', soundPath(id)]);
    const chain = demo.map((_, i) => `[${i}:a]apad=pad_dur=0.25[d${i}]`).join(';');
    await fs.mkdir(path.dirname(preview), { recursive: true });
    await execFileAsync(ffmpegBin, [
      '-y', '-v', 'error', ...inputs,
      '-filter_complex', `${chain};${demo.map((_, i) => `[d${i}]`).join('')}concat=n=${demo.length}:v=0:a=1,volume=0.6[a]`,
      '-map', '[a]', '-c:a', 'libmp3lame', '-b:a', '192k', preview,
    ]).catch((err) => console.warn('[SFX] Could not build the smart preview:', err));
  }
}

/**
 * Resolves the absolute filesystem path for an SFX preset track.
 * Returns null if track is "none" or file cannot be resolved.
 */
export async function resolveSfxPath(trackId: string): Promise<string | null> {
  // "smart" places effects across the whole video rather than one sound per beat
  if (!trackId || trackId === 'none' || trackId === 'smart') {
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
