import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath, getFfprobePath } from '../utils/ffmpeg';
import { xfadeTransitionOption } from './custom-transitions';

const execFileAsync = promisify(execFile);

/** 'style': each join gets a transition from the style's vocabulary (see transitions.ts). */
export type TransitionType = 'cut' | 'dip_black' | 'dip_white' | 'crossfade' | 'wipe' | 'style';

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
  /** Silence after the narration (the picture keeps going). */
  pauseSeconds?: number;
  /** Silence before the narration: the cut lands first and the voice follows. */
  leadInSeconds?: number;
  /** Fade up from black over the lead-in (the beat opens a section). */
  dipIn?: boolean;
  /** Fade down to black over the pause (the next beat opens a section). */
  dipOut?: boolean;
}

/**
 * Contain-fit filter that scales media to fit inside 1920x1080 without distortion,
 * center-pads with black bars (letterbox/pillarbox), sets 1:1 pixel aspect ratio,
 * and formats pixel format to yuv420p.
 */
export const CONTAIN_FIT_VF =
  'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,scale=out_range=tv,format=yuv420p';

/**
 * For short video clips, tpad clones the final frame indefinitely so the scene
 * holds its last visual state instead of freezing or ending early.
 */
export const CONTAIN_FIT_HOLD_VF =
  'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,tpad=stop_mode=clone:stop=-1,setsar=1,scale=out_range=tv,format=yuv420p';

/**
 * Filter complexes for blurred duplicate background padding.
 * Non-16:9 media has its background filled with a darkened, Gaussian-blurred
 * version of itself, creating a broadcast-quality aesthetic.
 */
export const BLUR_PAD_VIDEO_HOLD_FC =
  '[0:v]split=2[v_bg][v_fg];' +
  '[v_bg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=25,eq=brightness=-0.08:contrast=1.05,tpad=stop_mode=clone:stop=-1[bg_blur];' +
  '[v_fg]scale=1920:1080:force_original_aspect_ratio=decrease,tpad=stop_mode=clone:stop=-1[fg_fit];' +
  '[bg_blur][fg_fit]overlay=(W-w)/2:(H-h)/2,setsar=1,scale=out_range=tv,format=yuv420p[vout]';

export const BLUR_PAD_VIDEO_LOOP_FC =
  '[0:v]split=2[v_bg][v_fg];' +
  '[v_bg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=25,eq=brightness=-0.08:contrast=1.05[bg_blur];' +
  '[v_fg]scale=1920:1080:force_original_aspect_ratio=decrease[fg_fit];' +
  '[bg_blur][fg_fit]overlay=(W-w)/2:(H-h)/2,setsar=1,scale=out_range=tv,format=yuv420p[vout]';

export const BLUR_PAD_STILL_STATIC_FC =
  '[0:v]split=2[v_bg][v_fg];' +
  '[v_bg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=25,eq=brightness=-0.08:contrast=1.05[bg_blur];' +
  '[v_fg]scale=1920:1080:force_original_aspect_ratio=decrease[fg_fit];' +
  '[bg_blur][fg_fit]overlay=(W-w)/2:(H-h)/2,setsar=1,scale=out_range=tv,format=yuv420p[vout]';

/**
 * Ken Burns Dynamic Motion (subtle slow zoom on still graphics).
 * Center-anchored zoom formula keeps focal point dead-center.
 */
export const KEN_BURNS_ZOOM_VF =
  'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,' +
  'zoompan=z=\'min(zoom+0.0006,1.10)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=1:s=1920x1080:fps=30,setsar=1,scale=out_range=tv,format=yuv420p';

export const BLUR_PAD_STILL_ZOOM_FC =
  '[0:v]split=2[v_bg][v_fg];' +
  '[v_bg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=25,eq=brightness=-0.08:contrast=1.05[bg_blur];' +
  '[v_fg]scale=1920:1080:force_original_aspect_ratio=decrease[fg_fit];' +
  '[bg_blur][fg_fit]overlay=(W-w)/2:(H-h)/2,' +
  'zoompan=z=\'min(zoom+0.0015,1.15)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=1:s=1920x1080:fps=30,setsar=1,scale=out_range=tv,format=yuv420p[vout]';

export const LOUDNORM_AF = 'loudnorm=I=-16:TP=-1.5:LRA=11';

/**
 * Broadcast voice chain applied to each beat's narration: rumble cut, a little less boxiness,
 * presence for clarity, de-essing, and gentle compression so words sit at an even level.
 * Loudness is set once for the whole programme at mastering (single-pass loudnorm on short
 * beats made levels jump from beat to beat).
 */
export const VOICE_CHAIN_AF =
  'highpass=f=70,equalizer=f=250:t=q:w=1:g=-1.5,equalizer=f=3500:t=q:w=1.2:g=2,' +
  'deesser=i=0.3,acompressor=threshold=0.1:ratio=2.5:attack=15:release=200:makeup=1.6';

/**
 * Scene clips are intermediates that are joined (and maybe captioned) later, so they're encoded
 * near-transparently; the final quality is decided once, at mastering.
 */
export const SCENE_VIDEO_ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-color_range', 'tv'];
export const SCENE_AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2'];

/**
 * True when a video is already a finished 1080p30 H.264 track at least `minSec` long (beats
 * composed from shots are), so the scene can copy its picture instead of re-encoding it.
 */
export async function isPassThroughVideo(filePath: string, minSec: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(getFfprobePath(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate:format=duration',
      '-of', 'json', filePath,
    ]);
    const info = JSON.parse(stdout) as {
      streams?: Array<{ codec_name?: string; width?: number; height?: number; pix_fmt?: string; r_frame_rate?: string }>;
      format?: { duration?: string };
    };
    const s = info.streams?.[0];
    const duration = Number.parseFloat(info.format?.duration ?? '0');
    return Boolean(
      s &&
        s.codec_name === 'h264' &&
        s.width === 1920 &&
        s.height === 1080 &&
        s.pix_fmt === 'yuv420p' &&
        s.r_frame_rate === '30/1' &&
        duration >= minSec - 1 / 30,
    );
  } catch {
    return false;
  }
}

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
  const leadInMs = Math.round(Math.max(0, Math.min(3.0, Number(options.leadInSeconds ?? 0))) * 1000);
  const totalDurationMs = leadInMs + durationMs + pauseMs;
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
  // normalize=0: amix otherwise halves every input, so adding an effect would drop the voice 6 dB
  // The voice starts after the lead-in: the picture cuts first, the narrator follows
  const delay = leadInMs > 0 ? `,adelay=${leadInMs}:all=1` : '';
  const audioFC = `[1:a]${VOICE_CHAIN_AF}${delay},apad[voice];[2:a]volume=${sfxVol}[sfx];[voice][sfx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;
  const voiceOnlyAF = `${VOICE_CHAIN_AF}${delay},apad`;

  const args: string[] = ['-y'];

  // Fades: the video-wide dip setting fades every beat; otherwise only section changes dip,
  // inside the silent lead-in and tail so no words are darkened
  const globalDip = transition === 'dip_black' || transition === 'dip_white';
  const fadeColor = transition === 'dip_white' ? 'white' : 'black';
  const globalFadeSec = Math.min(transition === 'dip_white' ? 0.2 : 0.35, Math.max(0.05, totalDurationMs / 4000));
  const fadeInSec = globalDip ? globalFadeSec : options.dipIn && leadInMs > 0 ? Math.min(0.5, (leadInMs / 1000) * 0.85) : 0;
  const fadeOutSec = globalDip ? globalFadeSec : options.dipOut && pauseMs > 0 ? Math.min(0.5, (pauseMs / 1000) * 0.85) : 0;
  const isDip = fadeInSec > 0 || fadeOutSec > 0;

  // Fast path: a finished track (a beat composed from shots) keeps its picture untouched
  if (
    isVideo &&
    !isDip &&
    !(startOffsetSeconds > 0) &&
    shortVideoBehavior === 'hold' &&
    (await isPassThroughVideo(visualPath, totalDurationMs / 1000))
  ) {
    args.push('-i', visualPath, '-i', audioPath);
    if (hasSfx && sfxPath) {
      args.push('-i', sfxPath, '-filter_complex', audioFC, '-map', '0:v:0', '-map', '[aout]');
    } else {
      args.push('-map', '0:v:0', '-map', '1:a:0', '-af', voiceOnlyAF);
    }
    args.push('-c:v', 'copy', ...SCENE_AUDIO_ENCODE, '-t', totalDurationSec, outputPath);
    try {
      await execFileAsync(ffmpegBin, args);
      return outputPath;
    } catch (err) {
      throw new Error(`FFmpeg failed rendering beat scene (${outputPath}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const fadeStr = [
    fadeInSec > 0 ? `fade=t=in:st=0:d=${fadeInSec.toFixed(3)}:c=${fadeColor}` : '',
    fadeOutSec > 0 ? `fade=t=out:st=${Math.max(0, totalDurationMs / 1000 - fadeOutSec).toFixed(3)}:d=${fadeOutSec.toFixed(3)}:c=${fadeColor}` : '',
  ]
    .filter(Boolean)
    .join(',');

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

    args.push(...SCENE_VIDEO_ENCODE, '-r', String(fps), ...SCENE_AUDIO_ENCODE, '-t', totalDurationSec, outputPath);
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

    args.push(...SCENE_VIDEO_ENCODE, '-r', String(fps), ...SCENE_AUDIO_ENCODE, '-t', totalDurationSec, outputPath);
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

/** joinSceneClips, returning only the output path. */
export async function concatenateSceneClips(
  sceneClipPaths: string[],
  outputPath: string,
  tempDir: string,
  options?: ConcatenateSceneClipsOptions,
): Promise<string> {
  return (await joinSceneClips(sceneClipPaths, outputPath, tempDir, options)).outputPath;
}

export interface ConcatenateSceneClipsOptions {
  transition?: TransitionType;
  transitionDuration?: number;
  /** One transition per join (style-matched); overrides `transition` when given. */
  joins?: Array<{ type: string; sec: number }>;
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

/** Crossfades join at most this many clips in one ffmpeg command (each input is a full 1080p decoder). */
export const XFADE_GROUP_SIZE = 6;

/**
 * Crossfades clips in one ffmpeg command: each clip overlaps the next by `transSec`, picture and
 * sound together. Durations are the clips' own (probed by the caller).
 */
async function xfadeClips(clipPaths: string[], durations: number[], transSec: number, xfadeType: string, outputPath: string): Promise<void> {
  if (clipPaths.length === 1) {
    await fs.copyFile(clipPaths[0], outputPath);
    return;
  }
  const vFilters: string[] = [];
  const aFilters: string[] = [];
  let prevV = '0:v';
  let prevA = '0:a';
  let offset = durations[0] - transSec;
  for (let i = 1; i < clipPaths.length; i++) {
    const last = i === clipPaths.length - 1;
    const outV = last ? 'vout' : `vtrans${i}`;
    const outA = last ? 'aout' : `atrans${i}`;
    vFilters.push(`[${prevV}][${i}:v]xfade=transition=${xfadeType}:duration=${transSec.toFixed(3)}:offset=${offset.toFixed(3)}[${outV}]`);
    aFilters.push(`[${prevA}][${i}:a]acrossfade=d=${transSec.toFixed(3)}[${outA}]`);
    prevV = outV;
    prevA = outA;
    offset += durations[i] - transSec;
  }
  await execFileAsync(
    getFfmpegPath(),
    [
      '-y',
      ...clipPaths.flatMap((p) => ['-i', p]),
      '-filter_complex',
      [...vFilters, ...aFilters].join(';'),
      '-map', '[vout]',
      '-map', '[aout]',
      ...SCENE_VIDEO_ENCODE,
      '-r', '30',
      ...SCENE_AUDIO_ENCODE,
      outputPath,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

/**
 * Crossfades any number of clips in groups of XFADE_GROUP_SIZE, then crossfades the groups the
 * same way. Every clip still overlaps the next by `transSec` at the same moment as in a single
 * pass, but only a handful of decoders run at once (one 29-clip command ran an 8 GB machine out
 * of memory, and the video fell back to cuts while captions assumed crossfades).
 */
async function xfadeInGroups(
  clipPaths: string[],
  durations: number[],
  transSec: number,
  xfadeType: string,
  outputPath: string,
  tempDir: string,
  level = 0,
): Promise<void> {
  if (clipPaths.length <= XFADE_GROUP_SIZE) {
    await xfadeClips(clipPaths, durations, transSec, xfadeType, outputPath);
    return;
  }
  const groupPaths: string[] = [];
  const groupDurations: number[] = [];
  try {
    for (let start = 0; start < clipPaths.length; start += XFADE_GROUP_SIZE) {
      const paths = clipPaths.slice(start, start + XFADE_GROUP_SIZE);
      const durs = durations.slice(start, start + XFADE_GROUP_SIZE);
      const groupPath = path.join(tempDir, `xfade_l${level}_g${groupPaths.length}.mp4`);
      await xfadeClips(paths, durs, transSec, xfadeType, groupPath);
      groupPaths.push(groupPath);
      groupDurations.push(durs.reduce((a, b) => a + b, 0) - (durs.length - 1) * transSec);
    }
    await xfadeInGroups(groupPaths, groupDurations, transSec, xfadeType, outputPath, tempDir, level + 1);
  } finally {
    await Promise.all(groupPaths.map((p) => fs.unlink(p).catch(() => {})));
  }
}

/**
 * Joins clips with a different transition at each join: an xfade (with an audio crossfade) or a
 * cut (concat), in one ffmpeg command per group of XFADE_GROUP_SIZE clips, then the groups the
 * same way. `joins[i]` is the join between clip i and i+1.
 */
async function joinMixedClips(clipPaths: string[], durations: number[], joins: Array<{ type: string; sec: number }>, outputPath: string): Promise<void> {
  if (clipPaths.length === 1) {
    await fs.copyFile(clipPaths[0], outputPath);
    return;
  }
  // One timebase and frame rate for every input: concat outputs a different timebase than the
  // clips have, and xfade refuses to mix the two
  const filters: string[] = clipPaths.flatMap((_, i) => [
    `[${i}:v]fps=30,settb=AVTB,format=yuv420p[in${i}]`,
    `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[ia${i}]`,
  ]);
  let prevV = 'in0';
  let prevA = 'ia0';
  let length = durations[0];
  for (let i = 1; i < clipPaths.length; i++) {
    const last = i === clipPaths.length - 1;
    const outV = last ? 'vout' : `v${i}`;
    const outA = last ? 'aout' : `a${i}`;
    const join = joins[i - 1];
    if (!join || join.type === 'cut' || join.sec <= 0) {
      filters.push(`[${prevV}][${prevA}][in${i}][ia${i}]concat=n=2:v=1:a=1[${outV}][${outA}]`);
      length += durations[i];
    } else {
      filters.push(`[${prevV}][in${i}]xfade=${xfadeTransitionOption(join.type)}:duration=${join.sec.toFixed(3)}:offset=${(length - join.sec).toFixed(3)}[${outV}]`);
      filters.push(`[${prevA}][ia${i}]acrossfade=d=${join.sec.toFixed(3)}[${outA}]`);
      length += durations[i] - join.sec;
    }
    prevV = outV;
    prevA = outA;
  }
  // Rendered transitions are long expressions: the graph goes through a file (Windows caps
  // command-line length)
  const scriptPath = `${outputPath}.join-graph.txt`;
  await fs.writeFile(scriptPath, filters.join(';\n'), 'utf-8');
  try {
    await execFileAsync(
      getFfmpegPath(),
      ['-y', ...clipPaths.flatMap((p) => ['-i', p]), '-/filter_complex', scriptPath, '-map', '[vout]', '-map', '[aout]', ...SCENE_VIDEO_ENCODE, '-r', '30', ...SCENE_AUDIO_ENCODE, outputPath],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    await fs.unlink(scriptPath).catch(() => {});
  }
}

/** joinMixedClips over any number of clips, a group at a time (see xfadeInGroups). */
async function joinMixedInGroups(
  clipPaths: string[],
  durations: number[],
  joins: Array<{ type: string; sec: number }>,
  outputPath: string,
  tempDir: string,
  level = 0,
): Promise<void> {
  if (clipPaths.length <= XFADE_GROUP_SIZE) {
    await joinMixedClips(clipPaths, durations, joins, outputPath);
    return;
  }
  const groupPaths: string[] = [];
  const groupDurations: number[] = [];
  const groupJoins: Array<{ type: string; sec: number }> = [];
  try {
    for (let start = 0; start < clipPaths.length; start += XFADE_GROUP_SIZE) {
      const end = Math.min(clipPaths.length, start + XFADE_GROUP_SIZE);
      const inner = joins.slice(start, end - 1);
      const durs = durations.slice(start, end);
      const groupPath = path.join(tempDir, `join_l${level}_g${groupPaths.length}.mp4`);
      await joinMixedClips(clipPaths.slice(start, end), durs, inner, groupPath);
      groupPaths.push(groupPath);
      groupDurations.push(durs.reduce((a, b) => a + b, 0) - inner.reduce((a, j) => a + (j.type === 'cut' ? 0 : j.sec), 0));
      // The join between this group's last clip and the next group's first
      if (end < clipPaths.length) groupJoins.push(joins[end - 1] ?? { type: 'cut', sec: 0 });
    }
    await joinMixedInGroups(groupPaths, groupDurations, groupJoins, outputPath, tempDir, level + 1);
  } finally {
    await Promise.all(groupPaths.map((p) => fs.unlink(p).catch(() => {})));
  }
}

export interface JoinedScenes {
  outputPath: string;
  /** How much each clip actually overlaps the next: the crossfade length, or 0 when joined with cuts. */
  overlapSec: number;
  /** Each join's overlap, in order (style-matched joins differ; otherwise all equal overlapSec). */
  overlapsSec: number[];
}

/**
 * Joins scene clips into one MP4 and reports how, so captions, chapters and sound are timed from
 * what really happened:
 * - crossfade / wipe: clips overlap (in groups, see xfadeInGroups); if that fails, they are
 *   joined with cuts instead and `overlapSec` is 0
 * - cut, dip_black, dip_white: lossless stream-copy concat (dips are already in the clips)
 */
export async function joinSceneClips(
  sceneClipPaths: string[],
  outputPath: string,
  tempDir: string,
  options?: ConcatenateSceneClipsOptions,
): Promise<JoinedScenes> {
  if (!sceneClipPaths || sceneClipPaths.length === 0) {
    throw new Error('No scene clips provided for concatenation');
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  if (sceneClipPaths.length === 1) {
    await fs.copyFile(sceneClipPaths[0], outputPath);
    return { outputPath, overlapSec: 0, overlapsSec: [] };
  }

  const transition = options?.transition || 'cut';
  const cuts = () => sceneClipPaths.slice(1).map(() => 0);

  // Style-matched: a transition per join; all cuts can still use the lossless concat below
  const joins = options?.joins?.slice(0, sceneClipPaths.length - 1);
  if (joins && joins.some((j) => j.type !== 'cut' && j.sec > 0)) {
    const durations = await Promise.all(sceneClipPaths.map((p) => probeClipDurationSec(p)));
    // Never overlap more than a third of either clip
    const safe = joins.map((j, i) =>
      j.type === 'cut' ? { type: 'cut', sec: 0 } : { type: j.type, sec: Math.min(j.sec, durations[i] / 3, durations[i + 1] / 3) },
    );
    try {
      await joinMixedInGroups(sceneClipPaths, durations, safe, outputPath, tempDir);
      const overlapsSec = safe.map((j) => (j.type === 'cut' ? 0 : j.sec));
      return { outputPath, overlapSec: Math.max(0, ...overlapsSec), overlapsSec };
    } catch (err) {
      const detail = err instanceof Error ? err.message.slice(-600) : String(err);
      console.warn(`[Assembly] Style-matched join failed; joining with cuts instead: ${detail}`);
    }
  }

  if (transition === 'crossfade' || transition === 'wipe') {
    const durations = await Promise.all(sceneClipPaths.map((p) => probeClipDurationSec(p)));
    const transSec = resolveTransitionSeconds(durations, options?.transitionDuration);
    try {
      await xfadeInGroups(sceneClipPaths, durations, transSec, transition === 'wipe' ? 'wipeleft' : 'fade', outputPath, tempDir);
      return { outputPath, overlapSec: transSec, overlapsSec: sceneClipPaths.slice(1).map(() => transSec) };
    } catch (err) {
      const detail = err instanceof Error ? err.message.slice(-600) : String(err);
      console.warn(`[Assembly] ${transition} join failed; joining with cuts instead (captions and chapters are timed for cuts): ${detail}`);
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
    return { outputPath, overlapSec: 0, overlapsSec: cuts() };
  } catch (err) {
    throw new Error(
      `FFmpeg concat demuxer failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
