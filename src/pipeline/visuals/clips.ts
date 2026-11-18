import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath, getFfprobePath } from '../utils/ffmpeg';
import { BLUR_PAD_VIDEO_HOLD_FC } from '../assembly/assemble-beat';
import { FPS } from './motion/frame-renderer';
import { GATE_WEAVE_FILTER, printComposeFilter, textureOverlayFilter, type ArchiveTreatment } from './archive-look';

const execFileAsync = promisify(execFile);

/**
 * Camera moves for stills. The first four are the documentary moves; pop, shake and bounce are
 * for stickman drawings, chosen by the drawing's mood (a punch-in on a surprise, a shake on a
 * scare, a bob on a happy moment).
 */
export type StillMotion = 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'pop' | 'shake' | 'bounce';
export const STILL_MOTIONS: StillMotion[] = ['zoom_in', 'pan_right', 'zoom_out', 'pan_left'];

// JPEG stills and some sources are full-range; every clip is converted to (and tagged) TV range
// so a joined track never inherits a full-range tag that skews the footage's contrast
export const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', String(FPS), '-an'];

/**
 * Camera move for a still, as zoompan expressions over `frames` output frames. Stills are
 * upscaled to 4K first so sub-pixel movement doesn't jitter at 1080p.
 */
export function kenBurnsFilter(motion: StillMotion, frames: number): string {
  const n = Math.max(1, frames - 1);
  const progress = `(on/${n})`;
  const centerX = "iw/2-(iw/zoom/2)";
  const centerY = "ih/2-(ih/zoom/2)";
  const moves: Record<StillMotion, { z: string; x: string; y: string }> = {
    zoom_in: { z: `1+0.14*${progress}`, x: centerX, y: centerY },
    zoom_out: { z: `1.14-0.14*${progress}`, x: centerX, y: centerY },
    pan_right: { z: '1.12', x: `(iw-iw/zoom)*${progress}`, y: centerY },
    pan_left: { z: '1.12', x: `(iw-iw/zoom)*(1-${progress})`, y: centerY },
    // Snaps in from 115% over the first quarter second, then drifts slowly
    pop: { z: `if(lt(on,8),1.15-0.15*on/8,1+0.04*(on-8)/${n})`, x: centerX, y: centerY },
    // A jolt that dies away over the first half second, on a slow push-in
    shake: {
      z: `1.08+0.04*${progress}`,
      x: `${centerX}+44*sin(on*2.3)*max(0,1-on/15)`,
      y: `${centerY}+30*cos(on*2.9)*max(0,1-on/15)`,
    },
    // A gentle bob, about one a second
    bounce: { z: '1.06', x: centerX, y: `${centerY}+26*sin(on*2*PI/${FPS})` },
  };
  const { z, x, y } = moves[motion];
  return `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=1920x1080:fps=${FPS}`;
}

/** Still image (any aspect) -> blurred-fill 16:9 frame -> camera move, exact frame count. */
async function stillClip(inputPath: string, frames: number, outputPath: string, motion: StillMotion): Promise<void> {
  const filter =
    '[0:v]split=2[bg][fg];' +
    '[bg]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,gblur=sigma=40,eq=brightness=-0.1[bgb];' +
    '[fg]scale=3840:2160:force_original_aspect_ratio=decrease[fgs];' +
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,${kenBurnsFilter(motion, frames)},setsar=1,scale=out_range=tv,format=yuv420p[v]`;
  await execFileAsync(getFfmpegPath(), ['-y', '-i', inputPath, '-filter_complex', filter, '-map', '[v]', '-frames:v', String(frames), ...ENCODE, outputPath]);
}

/**
 * A creator's drawing: laid on the page colour (transparent PNGs show the paper through; drawings
 * of another shape get paper margins, not a blurred copy of themselves), then moved, exact frame
 * count.
 */
export async function makeDrawingClip(
  inputPath: string,
  frames: number,
  outputPath: string,
  motion: StillMotion,
  paper: string,
  options: {
    focus?: [number, number, number, number] | null;
    /** A transparent 3840x2160 layer (a label or speech bubble) moved with the drawing, fading in at `layerAt` s. */
    layer?: string | null;
    layerAt?: number;
  } = {},
): Promise<{ outputPath: string; closeUp: boolean }> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const colour = ffmpegColour(await drawingPageColour(inputPath, paper));
  const fit = await drawingFit(inputPath);
  const camera = drawingCamera(motion, frames, options.focus && fit ? { box: options.focus, fit } : null);
  const page =
    `color=c=${colour}:s=3840x2160:r=${FPS}[page];` +
    '[0:v]format=rgba,scale=3840:2160:force_original_aspect_ratio=decrease[art];' +
    `[page][art]overlay=(W-w)/2:(H-h)/2:shortest=1,${camera.filter},setsar=1[cam];`;
  // The layer goes through the very same camera, so it stays fixed to the drawing
  const filter = options.layer
    ? `${page}[1:v]format=rgba,${camera.filter},format=rgba,fade=t=in:st=${(options.layerAt ?? 0.35).toFixed(2)}:d=0.3:alpha=1[note];` +
      '[cam][note]overlay=eof_action=pass,scale=out_range=tv,format=yuv420p[v]'
    : `${page}[cam]scale=out_range=tv,format=yuv420p[v]`;
  try {
    await execFileAsync(getFfmpegPath(), [
      '-y', '-i', inputPath, ...(options.layer ? ['-i', options.layer] : []),
      '-filter_complex', filter, '-map', '[v]', '-frames:v', String(frames), ...ENCODE, outputPath,
    ]);
    return { outputPath, closeUp: camera.closeUp };
  } catch (err) {
    throw new Error(`Failed to make drawing clip from ${path.basename(inputPath)}: ${err instanceof Error ? err.message.slice(-400) : err}`);
  }
}

/** The page a drawing sits on: its own background colour when opaque, else the style's paper (#rrggbb). */
export async function drawingPageColour(inputPath: string, paper: string): Promise<string> {
  const own = await drawingBackground(inputPath);
  const page = own ?? paper;
  return /^#[0-9a-f]{6}$/i.test(page) ? page : '#ffffff';
}

const ffmpegColour = (hex: string) => `0x${hex.slice(1)}`;

/** How a drawing fits the 3840x2160 page: its scale and where it sits (contain, centred). */
export interface DrawingFit {
  srcWidth: number;
  srcHeight: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export async function drawingFit(inputPath: string): Promise<DrawingFit | null> {
  try {
    const { stdout } = await execFileAsync(getFfprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', inputPath]);
    const [w, h] = stdout.trim().split(',').map(Number);
    if (!(w > 0 && h > 0)) return null;
    const scale = Math.min(3840 / w, 2160 / h);
    return { srcWidth: w, srcHeight: h, scale, offsetX: (3840 - w * scale) / 2, offsetY: (2160 - h * scale) / 2 };
  } catch {
    return null;
  }
}

/** Shots at least this long cut partway to a close-up of the drawing's subject. */
export const CLOSE_UP_MIN_FRAMES = 5 * FPS;
/** A close-up never crops the drawing narrower than this many of its own pixels (so it stays sharp). */
const CLOSE_UP_MIN_SOURCE_PX = 480;

/**
 * The camera for a drawing (zoompan over the 3840x2160 page). With a focus box, moves centre on the
 * subject instead of the middle (a push-in drifts toward it; a pop, shake or bob happens around
 * it), and a long shot cuts at about half way to a close-up of it, as tight as the drawing's
 * resolution allows. Without one, the plain camera moves.
 */
export function drawingCamera(
  motion: StillMotion,
  frames: number,
  focus: { box: [number, number, number, number]; fit: DrawingFit } | null,
): { filter: string; closeUp: boolean } {
  if (!focus || motion === 'pan_left' || motion === 'pan_right') return { filter: kenBurnsFilter(motion, frames), closeUp: false };
  const { box, fit } = focus;
  // The subject's centre and height as fractions of the page
  const r = (v: number) => Math.round(v * 10000) / 10000;
  const fx = r((fit.offsetX + ((box[1] + box[3]) / 2) * fit.srcWidth * fit.scale) / 3840);
  const fy = r((fit.offsetY + ((box[0] + box[2]) / 2) * fit.srcHeight * fit.scale) / 2160);
  const boxH = ((box[2] - box[0]) * fit.srcHeight * fit.scale) / 2160;

  const maxZoom = Math.min(2.6, 3840 / (CLOSE_UP_MIN_SOURCE_PX * fit.scale));
  const closeZoom = r(Math.min(maxZoom, Math.max(1.5, 0.6 / Math.max(boxH, 0.05))));
  const closeUp = frames >= CLOSE_UP_MIN_FRAMES && closeZoom >= 1.35 && maxZoom >= 1.35;
  const cut = closeUp ? Math.round(frames * 0.55) : frames;
  const n = Math.max(1, cut - 1);
  const p = `min(1,on/${n})`;

  const moves: Record<string, { z: string; cx: string; cy: string }> = {
    zoom_in: { z: `1+0.16*${p}`, cx: `0.5+(${fx}-0.5)*${p}`, cy: `0.5+(${fy}-0.5)*${p}` },
    zoom_out: { z: `1.16-0.16*${p}`, cx: `${fx}+(0.5-${fx})*${p}`, cy: `${fy}+(0.5-${fy})*${p}` },
    pop: { z: `if(lt(on,8),1.15-0.15*on/8,1+0.06*(on-8)/${n})`, cx: `0.5+(${fx}-0.5)*${p}`, cy: `0.5+(${fy}-0.5)*${p}` },
    shake: { z: `1.1+0.04*${p}`, cx: `${fx}+0.012*sin(on*2.3)*max(0,1-on/15)`, cy: `${fy}+0.012*cos(on*2.9)*max(0,1-on/15)` },
    bounce: { z: '1.1', cx: `${fx}`, cy: `${fy}+0.012*sin(on*2*PI/${FPS})` },
  };
  const move = moves[motion] ?? moves.zoom_in;
  // After the cut: tight on the subject, drifting in a touch
  const z = closeUp ? `if(lt(on,${cut}),${move.z},${closeZoom}+0.04*(on-${cut})/${Math.max(1, frames - cut)})` : move.z;
  const cx = closeUp ? `if(lt(on,${cut}),${move.cx},${fx})` : move.cx;
  const cy = closeUp ? `if(lt(on,${cut}),${move.cy},${fy})` : move.cy;
  const x = `clip((${cx})*iw-iw/zoom/2,0,iw-iw/zoom)`;
  const y = `clip((${cy})*ih-ih/zoom/2,0,ih-ih/zoom)`;
  return { filter: `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=1920x1080:fps=${FPS}`, closeUp };
}

/**
 * The background colour of an opaque drawing, as #rrggbb: the average of a thin strip along its top
 * edge, where drawings are almost always blank. Null for drawings with transparency (they take the
 * style's paper) or when it can't be read.
 */
export async function drawingBackground(inputPath: string): Promise<string | null> {
  try {
    const { stdout: fmt } = await execFileAsync(getFfprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', inputPath]);
    // Pixel formats with transparency (palette PNGs may have it too)
    if (/^(rgba|bgra|argb|abgr|yuva|ya8|ya16|pal8|gbrap|rgba64)/.test(fmt.trim())) return null;
    const { stdout } = await execFileAsync(
      getFfmpegPath(),
      ['-v', 'error', '-i', inputPath, '-vf', 'crop=iw:max(2\\,ih/50):0:0,scale=1:1:flags=area', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { encoding: 'buffer' },
    );
    const px = stdout as unknown as Buffer;
    if (px.length < 3) return null;
    return `#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

/**
 * An old photo as a print (see archive-look.ts): bordered, tilted, shadowed, over the previous
 * print when there is one, then the camera move, grain and an optional light leak.
 */
async function archiveStillClip(inputPath: string, frames: number, outputPath: string, motion: StillMotion, look: ArchiveTreatment): Promise<void> {
  const inputs = ['-i', inputPath];
  if (look.underPath) inputs.push('-i', look.underPath);
  // Input numbers: the photo, the print beneath (if any), then the grain
  const grainIdx = look.underPath ? 2 : 1;
  inputs.push('-stream_loop', '-1', '-i', look.textures.grain);
  const filter =
    `${printComposeFilter(look.tilt, Boolean(look.underPath))};` +
    `[print]${kenBurnsFilter(motion, frames)},setsar=1[kb];` +
    `${textureOverlayFilter('kb', 'tx', grainIdx, look.leak)};` +
    '[tx]scale=out_range=tv,format=yuv420p[v]';
  await execFileAsync(getFfmpegPath(), ['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-frames:v', String(frames), ...ENCODE, outputPath]);
}

/** Video -> blurred-fill 16:9, starting at `startSec`, holding the last frame if it runs short. */
async function videoClip(inputPath: string, frames: number, outputPath: string, startSec: number, look?: ArchiveTreatment): Promise<void> {
  const seconds = frames / FPS;
  let filter = BLUR_PAD_VIDEO_HOLD_FC.replace('[vout]', `,fps=${FPS}[vout]`);
  const extra: string[] = [];
  if (look) {
    // Old film: gate weave and flicker, then grain (and a light leak) over it
    extra.push('-stream_loop', '-1', '-i', look.textures.grain);
    filter =
      BLUR_PAD_VIDEO_HOLD_FC.replace('[vout]', `,fps=${FPS},${GATE_WEAVE_FILTER}[woven]`) +
      `;${textureOverlayFilter('woven', 'tx', 1, look.leak)};[tx]scale=out_range=tv,format=yuv420p[vout]`;
  }
  await execFileAsync(getFfmpegPath(), [
    '-y',
    ...(startSec > 0 ? ['-ss', startSec.toFixed(3)] : []),
    '-t', (seconds + 1).toFixed(3),
    '-i', inputPath,
    ...extra,
    '-filter_complex', filter,
    '-map', '[vout]',
    '-frames:v', String(frames),
    ...ENCODE,
    outputPath,
  ]);
}

export interface FootageClipOptions {
  inputPath: string;
  isVideo: boolean;
  frames: number;
  outputPath: string;
  /** Video only: where in the source to start. */
  startSec?: number;
  /** Still only: which camera move. */
  motion?: StillMotion;
  /** Archive texture for historical footage (see archive-look.ts); absent = plain. */
  archiveLook?: ArchiveTreatment;
}

/** Renders a silent 1920x1080 clip of exactly `frames` frames from a photo or video. */
export async function makeFootageClip(options: FootageClipOptions): Promise<string> {
  const { inputPath, isVideo, frames, outputPath, startSec = 0, motion = 'zoom_in', archiveLook } = options;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    if (isVideo) await videoClip(inputPath, frames, outputPath, startSec, archiveLook);
    else if (archiveLook) await archiveStillClip(inputPath, frames, outputPath, motion, archiveLook);
    else await stillClip(inputPath, frames, outputPath, motion);
    return outputPath;
  } catch (err) {
    throw new Error(`Failed to make footage clip from ${path.basename(inputPath)}: ${err instanceof Error ? err.message.slice(-400) : err}`);
  }
}

/**
 * Lays a transparent 1920x1080 PNG (a lower-third caption) over a clip: it slides in and fades
 * up shortly after the cut, and fades out before the end when the shot is long enough.
 */
export async function overlayCaption(clipPath: string, overlayPng: string, frames: number, outputPath: string): Promise<string> {
  const seconds = frames / FPS;
  const inAt = 0.35;
  const inLen = 0.45;
  const fadeOut = seconds > 3 ? `,fade=t=out:st=${(seconds - 0.55).toFixed(3)}:d=0.4:alpha=1` : '';
  const slide = `-70*(1-min(1,max(0,(t-${inAt})/${inLen})))`;
  const filter =
    `[1:v]format=rgba,fade=t=in:st=${inAt}:d=${inLen}:alpha=1${fadeOut}[cap];` +
    `[0:v][cap]overlay=x='${slide}':y=0:eval=frame:shortest=1,scale=out_range=tv,format=yuv420p[v]`;
  await execFileAsync(getFfmpegPath(), [
    '-y', '-i', clipPath, '-loop', '1', '-framerate', String(FPS), '-i', overlayPng,
    '-filter_complex', filter, '-map', '[v]', '-frames:v', String(frames), ...ENCODE, outputPath,
  ]);
  return outputPath;
}

/** A plain color clip, used when a shot can't be sourced so the beat still has exact timing. */
export async function makeColorClip(color: string, frames: number, outputPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(getFfmpegPath(), [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1920x1080:r=${FPS}`, '-frames:v', String(frames), ...ENCODE, outputPath,
  ]);
  return outputPath;
}

/**
 * Joins shot clips (all 1920x1080, 30 fps, H.264) into one beat track. Clips share encoding
 * settings, so stream copy is lossless and fast.
 */
export async function concatClips(clipPaths: string[], outputPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (clipPaths.length === 1) {
    await fs.copyFile(clipPaths[0], outputPath);
    return outputPath;
  }
  const listPath = `${outputPath}.concat.txt`;
  await fs.writeFile(listPath, clipPaths.map((p) => `file '${path.resolve(p).replace(/\\/g, '/')}'`).join('\n'), 'utf-8');
  try {
    await execFileAsync(getFfmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
  } finally {
    await fs.unlink(listPath).catch(() => {});
  }
  return outputPath;
}

/**
 * A shot clip at a new length, same picture: cut short, or held on its last frame when longer.
 * Encoded like every shot clip, so the beat still joins by stream copy.
 */
export async function retimeClip(inputPath: string, frames: number, outputPath: string): Promise<string> {
  await execFileAsync(getFfmpegPath(), [
    '-y', '-v', 'error', '-i', inputPath,
    '-vf', 'tpad=stop_mode=clone:stop=-1,scale=out_range=tv,format=yuv420p',
    '-frames:v', String(frames), ...ENCODE, outputPath,
  ]);
  return outputPath;
}
