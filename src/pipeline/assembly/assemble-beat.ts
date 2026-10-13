import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath, getFfprobePath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);

export type TransitionType = 'cut' | 'dip_black' | 'dip_white' | 'crossfade' | 'wipe';

export interface RenderBeatSceneOptions {
  visualPath: string;
  audioPath: string;
  durationMs: number;
  outputPath: string;
  isVideo?: boolean;
  shortVideoBehavior?: 'hold' | 'loop';
  stillMotion?: 'static' | 'zoom';
  fps?: number;
  padStyle?: 'blur' | 'black';
  startOffsetSeconds?: number;
  transition?: TransitionType;
  sfxPath?: string | null;
  sfxVolume?: number;
  pauseSeconds?: number;
}

/**
 * Contain-fit filter that scales media to fit inside 1920x1080 without distortion,
 * center-pads with black bars (letterbox/pillarbox), sets 1:1 pixel aspect ratio,
 * and formats pixel format to yuv420p.
 */
export const CONTAIN_FIT_VF =
  'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p';

/**
 * For short video clips, tpad clones the final frame indefinitely so the scene
 * holds its last visual state instead of freezing or ending early.
 */
export const CONTAIN_FIT_HOLD_VF =
  'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,tpad=stop_mode=clone:stop=-1,setsar=1,format=yuv420p';

/**
 * Filter complexes for blurred duplicate background padding.
 * Non-16:9 media has its background filled with a darkened, Gaussian-blurred
 * version of itself, creating a broadcast-quality aesthetic.
 */
export const BLUR_PAD_VIDEO_HOLD_FC =
  '[0:v]split=2[v_bg][v_fg];' +
  '[v_bg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=25,eq=brightness=-0.08:contrast=1.05,tpad=stop_mode=clone:stop=-1[bg_blur];' +
  '[v_fg]scale=1920:1080:force_original_aspect_ratio=decrease,tpad=stop_mode=clone:stop=-1[fg_fit];' +
  '[bg_blur][fg_fit]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[vout]';

export const BLUR_PAD_VIDEO_LOOP_FC =
  '[0:v]split=2[v_bg][v_fg];' +
  '[v_bg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=25,eq=brightness=-0.08:contrast=1.05[bg_blur];' +
  '[v_fg]scale=1920:1080:force_original_aspect_ratio=decrease[fg_fit];' +
  '[bg_blur][fg_fit]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[vout]';

export const BLUR_PAD_STILL_STATIC_FC =
  '[0:v]split=2[v_bg][v_fg];' +
  '[v_bg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=25,eq=brightness=-0.08:contrast=1.05[bg_blur];' +
  '[v_fg]scale=1920:1080:force_original_aspect_ratio=decrease[fg_fit];' +
  '[bg_blur][fg_fit]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[vout]';

/**
 * Ken Burns Dynamic Motion (subtle slow zoom on still graphics).
 * Center-anchored zoom formula keeps focal point dead-center.
 */
export const KEN_BURNS_ZOOM_VF =
  'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,' +
  'zoompan=z=\'min(zoom+0.0006,1.10)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=1:s=1920x1080:fps=30,setsar=1,format=yuv420p';

export const BLUR_PAD_STILL_ZOOM_FC =
  '[0:v]split=2[v_bg][v_fg];' +
  '[v_bg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=25,eq=brightness=-0.08:contrast=1.05[bg_blur];' +
  '[v_fg]scale=1920:1080:force_original_aspect_ratio=decrease[fg_fit];' +
  '[bg_blur][fg_fit]overlay=(W-w)/2:(H-h)/2,' +
  'zoompan=z=\'min(zoom+0.0015,1.15)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=1:s=1920x1080:fps=30,setsar=1,format=yuv420p[vout]';

export const LOUDNORM_AF = 'loudnorm=I=-16:TP=-1.5:LRA=11';

/**
 * Probes clip duration in seconds using ffprobe.
 */
export async function probeClipDurationSec(filePath: string): Promise<number> {
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
    const dur = Number.parseFloat(stdout.trim());
    return Number.isFinite(dur) && dur > 0 ? dur : 3.0;
  } catch {
    return 3.0;
  }
}

/**
 * Renders a single beat scene clip combining visual asset and beat audio:
 * - Scene duration = exact measured TTS duration in ms (converted to seconds).
 * - Video asset: strips original audio, contains-fits to 1920x1080 with blurred duplicate
 *   background (or black padding), holds last frame if shorter than audio (or loops if requested).
 * - Image asset: still contain-fit (with blurred padding) or slow Ken Burns zoom.
 * - Audio: beat narration normalized with loudnorm around -16 LUFS, AAC 48kHz stereo.
 * - Transitions: dip_black or dip_white applies smooth in/out fades to clip boundaries.
 */
export async function renderBeatScene(options: RenderBeatSceneOptions): Promise<string> {
  const {
    visualPath,
    audioPath,
    durationMs,
    outputPath,
    isVideo = false,
    shortVideoBehavior = 'hold',
    stillMotion = 'zoom',
    fps = 30,
    padStyle = 'blur',
    startOffsetSeconds = 0,
    transition = 'cut',
    sfxPath = null,
    sfxVolume = 0.25,
    pauseSeconds = 0,
  } = options;

  if (!durationMs || durationMs <= 0) {
    throw new Error(`Invalid scene durationMs: ${durationMs}. Must be greater than 0.`);
  }

  const pauseSecClamped = Math.max(0, Math.min(3.0, Number(pauseSeconds ?? 0.5)));
  const pauseMs = Math.round(pauseSecClamped * 1000);
  const totalDurationMs = durationMs + pauseMs;
  const totalDurationSec = (totalDurationMs / 1000).toFixed(3);
  const ffmpegBin = getFfmpegPath();

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const hasSfx = Boolean(
    sfxPath &&
      (await fs
        .stat(sfxPath)
        .then((s) => s.isFile() && s.size > 0)
        .catch(() => false)),
  );

  const sfxVol = Math.max(0.02, Math.min(0.8, sfxVolume)).toFixed(2);
  const audioFC = `[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,apad[voice];[2:a]volume=${sfxVol}[sfx];[voice][sfx]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
  const voiceOnlyAF = 'loudnorm=I=-16:TP=-1.5:LRA=11,apad';

  const args: string[] = ['-y'];

  // Prepare dip to black or flash to white transition string if selected
  const isDip = transition === 'dip_black' || transition === 'dip_white';
  const fadeColor = transition === 'dip_white' ? 'white' : 'black';
  const targetFade = transition === 'dip_white' ? 0.20 : 0.35;
  const fadeSec = Math.min(targetFade, Math.max(0.05, totalDurationMs / 4000));
  const fadeOutStart = Math.max(0, (totalDurationMs / 1000) - fadeSec).toFixed(3);
  const fadeStr = `fade=t=in:st=0:d=${fadeSec.toFixed(3)}:c=${fadeColor},fade=t=out:st=${fadeOutStart}:d=${fadeSec.toFixed(3)}:c=${fadeColor}`;

  if (isVideo) {
    if (shortVideoBehavior === 'loop') {
      args.push('-stream_loop', '-1');
    }
    if (startOffsetSeconds && startOffsetSeconds > 0) {
      args.push('-ss', startOffsetSeconds.toFixed(3));
    }
    args.push('-i', visualPath);
    args.push('-i', audioPath);
    if (hasSfx && sfxPath) {
      args.push('-i', sfxPath);
    }

    if (padStyle === 'blur') {
      let filterComplex =
        shortVideoBehavior === 'loop' ? BLUR_PAD_VIDEO_LOOP_FC : BLUR_PAD_VIDEO_HOLD_FC;
      if (isDip) {
        filterComplex = filterComplex.replace('[vout]', `,${fadeStr}[vout]`);
      }
      if (hasSfx) {
        args.push(
          '-filter_complex',
          `${filterComplex};${audioFC}`,
          '-map',
          '[vout]',
          '-map',
          '[aout]',
        );
      } else {
        args.push(
          '-filter_complex',
          filterComplex,
          '-map',
          '[vout]',
          '-map',
          '1:a:0',
          '-af',
          voiceOnlyAF,
        );
      }
    } else {
      let vf = shortVideoBehavior === 'loop' ? CONTAIN_FIT_VF : CONTAIN_FIT_HOLD_VF;
      if (isDip) {
        vf = `${vf},${fadeStr}`;
      }
      if (hasSfx) {
        args.push(
          '-filter_complex',
          `[0:v]${vf}[vout];${audioFC}`,
          '-map',
          '[vout]',
          '-map',
          '[aout]',
        );
      } else {
        args.push(
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-vf',
          vf,
          '-af',
          voiceOnlyAF,
        );
      }
    }

    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-t',
      totalDurationSec,
      outputPath,
    );
  } else {
    // Still image
    args.push('-loop', '1', '-i', visualPath);
    args.push('-i', audioPath);
    if (hasSfx && sfxPath) {
      args.push('-i', sfxPath);
    }

    if (padStyle === 'blur') {
      let filterComplex =
        stillMotion === 'zoom' ? BLUR_PAD_STILL_ZOOM_FC : BLUR_PAD_STILL_STATIC_FC;
      if (isDip) {
        filterComplex = filterComplex.replace('[vout]', `,${fadeStr}[vout]`);
      }
      if (hasSfx) {
        args.push(
          '-filter_complex',
          `${filterComplex};${audioFC}`,
          '-map',
          '[vout]',
          '-map',
          '[aout]',
        );
      } else {
        args.push(
          '-filter_complex',
          filterComplex,
          '-map',
          '[vout]',
          '-map',
          '1:a:0',
          '-af',
          voiceOnlyAF,
        );
      }
    } else {
      let vf = stillMotion === 'zoom' ? KEN_BURNS_ZOOM_VF : CONTAIN_FIT_VF;
      if (isDip) {
        vf = `${vf},${fadeStr}`;
      }
      if (hasSfx) {
        args.push(
          '-filter_complex',
          `[0:v]${vf}[vout];${audioFC}`,
          '-map',
          '[vout]',
          '-map',
          '[aout]',
        );
      } else {
        args.push(
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-vf',
          vf,
          '-af',
          voiceOnlyAF,
        );
      }
    }

    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-t',
      totalDurationSec,
      outputPath,
    );
  }

  try {
    await execFileAsync(ffmpegBin, args);
    return outputPath;
  } catch (err) {
    throw new Error(
      `FFmpeg failed rendering beat scene (${outputPath}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export interface ConcatenateSceneClipsOptions {
  transition?: TransitionType;
  transitionDuration?: number;
}

/**
 * Overlap (seconds) used by crossfade/wipe transitions, shrunk for very short clips.
 */
export function resolveTransitionSeconds(durationsSec: number[], requested = 0.5): number {
  const minDur = Math.min(...durationsSec);
  return requested * 2 >= minDur ? Math.max(0.1, minDur / 3) : requested;
}

/**
 * Start time (seconds) of each scene clip within the concatenated video.
 * Crossfade/wipe overlap consecutive clips; every other transition is back-to-back.
 */
export function computeSceneStartOffsetsSec(
  durationsSec: number[],
  transition: TransitionType = 'cut',
  transitionDuration?: number,
): number[] {
  const overlaps = durationsSec.length > 1 && (transition === 'crossfade' || transition === 'wipe');
  const transSec = overlaps ? resolveTransitionSeconds(durationsSec, transitionDuration) : 0;
  const starts: number[] = [];
  let t = 0;
  for (const d of durationsSec) {
    starts.push(t);
    t += d - transSec;
  }
  return starts;
}

/**
 * Concatenates scene clips into a single final MP4:
 * - If transition is 'crossfade' or 'wipe': renders multi-clip xfade with acrossfade audio.
 * - If transition is 'cut', 'dip_black', or 'dip_white': uses lossless -c copy concat demuxer
 *   (since dip transitions are cleanly embedded in the scene clips).
 */
export async function concatenateSceneClips(
  sceneClipPaths: string[],
  outputPath: string,
  tempDir: string,
  options?: ConcatenateSceneClipsOptions,
): Promise<string> {
  if (!sceneClipPaths || sceneClipPaths.length === 0) {
    throw new Error('No scene clips provided for concatenation');
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  if (sceneClipPaths.length === 1) {
    await fs.copyFile(sceneClipPaths[0], outputPath);
    return outputPath;
  }

  const transition = options?.transition || 'cut';

  if (transition === 'crossfade' || transition === 'wipe') {
    const ffmpegBin = getFfmpegPath();
    const xfadeType = transition === 'wipe' ? 'wipeleft' : 'fade';

    // Probe durations for accurate offset calculation
    const durations = await Promise.all(
      sceneClipPaths.map((p) => probeClipDurationSec(p)),
    );

    const transSec = resolveTransitionSeconds(durations, options?.transitionDuration);

    const inputArgs: string[] = [];
    sceneClipPaths.forEach((p) => {
      inputArgs.push('-i', p);
    });

    const vFilters: string[] = [];
    const aFilters: string[] = [];
    let prevV = '0:v';
    let prevA = '0:a';
    let currentOffset = durations[0] - transSec;

    for (let i = 1; i < sceneClipPaths.length; i++) {
      const nextV = `${i}:v`;
      const nextA = `${i}:a`;
      const outV = i === sceneClipPaths.length - 1 ? 'vout' : `vtrans${i}`;
      const outA = i === sceneClipPaths.length - 1 ? 'aout' : `atrans${i}`;

      vFilters.push(
        `[${prevV}][${nextV}]xfade=transition=${xfadeType}:duration=${transSec.toFixed(3)}:offset=${currentOffset.toFixed(3)}[${outV}]`,
      );
      aFilters.push(
        `[${prevA}][${nextA}]acrossfade=d=${transSec.toFixed(3)}[${outA}]`,
      );

      prevV = outV;
      prevA = outA;
      currentOffset = currentOffset + durations[i] - transSec;
    }

    const filterComplex = [...vFilters, ...aFilters].join(';');

    const args = [
      '-y',
      ...inputArgs,
      '-filter_complex',
      filterComplex,
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      outputPath,
    ];

    try {
      await execFileAsync(ffmpegBin, args);
      return outputPath;
    } catch (err) {
      console.warn('xfade concatenation failed, falling back to concat demuxer:', err);
    }
  }

  // Fast stream copy concat demuxer (for cut, dip_black, dip_white, and fallback)
  const concatListPath = path.join(tempDir, `concat_${Date.now()}.txt`);
  const fileLines = sceneClipPaths
    .map((p) => `file '${path.resolve(p).replace(/\\/g, '/')}'`)
    .join('\n');

  await fs.writeFile(concatListPath, fileLines, 'utf-8');

  const ffmpegBin = getFfmpegPath();
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
    await fs.unlink(concatListPath).catch(() => {});
    return outputPath;
  } catch (err) {
    throw new Error(
      `FFmpeg concat demuxer failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
