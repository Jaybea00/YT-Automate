import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import { FPS } from './motion/frame-renderer';

const execFileAsync = promisify(execFile);

/**
 * Archive texture: makes historical footage feel deliberate rather than pasted in. Old film gets
 * gate weave (the small frame wobble of a projector), a gentle flicker and grain; old photos
 * become physical prints (border, tilt, shadow), stacked on the previous print when there is
 * one, under the same grain. Every few archive shots open with a warm light leak. Modern stock
 * is never treated. Textures are rendered once and cached under storage/textures.
 */

const TEXTURE_VERSION = 'v1';
const texturesDir = () => path.join(process.cwd(), 'storage', 'textures');

export interface ArchiveTextures {
  /** 2 s grey noise loop, blended over clips as film grain. */
  grain: string;
}

let ensuring: Promise<ArchiveTextures> | null = null;

async function renderIfMissing(file: string, args: string[]): Promise<void> {
  try {
    await fs.access(file);
    return;
  } catch {
    // render below
  }
  const tmp = `${file}.${process.pid}.tmp.mp4`;
  await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', ...args, tmp]);
  await fs.rename(tmp, file).catch(async () => fs.rm(tmp, { force: true }));
}

/** The film-grain texture, rendering it the first time. */
export function ensureArchiveTextures(): Promise<ArchiveTextures> {
  ensuring ??= (async () => {
    await fs.mkdir(texturesDir(), { recursive: true });
    const grain = path.join(texturesDir(), `grain_${TEXTURE_VERSION}.mp4`);
    // Temporal noise on mid grey: neutral under overlay blending except for the grain itself
    await renderIfMissing(grain, [
      '-f', 'lavfi', '-i', `color=c=0x808080:s=1920x1080:r=${FPS}:d=2`,
      '-vf', 'noise=c0s=34:c0f=t+u,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-an',
    ]);
    return { grain };
  })().catch((err) => {
    ensuring = null;
    throw err;
  });
  return ensuring;
}

export interface ArchiveTreatment {
  textures: ArchiveTextures;
  /** Print tilt in degrees (stills). */
  tilt: number;
  /** The previous archive photo, shown as a print underneath (stills). */
  underPath?: string;
  /** Open with a light leak. */
  leak: boolean;
}

/** Tilts alternate side to side so consecutive prints never lean the same way. */
const TILTS = [-1.8, 1.3, -0.9, 2.0, -1.4, 0.8];
/** One archive shot in this many opens with a light leak. */
const LEAK_EVERY = 3;

/** Picks the treatment for the n-th archive shot of the video. */
export function treatmentFor(n: number, textures: ArchiveTextures, underPath?: string): ArchiveTreatment {
  return { textures, tilt: TILTS[n % TILTS.length], underPath, leak: n % LEAK_EVERY === 1 };
}

const BORDER = 'EFE8D6';

/**
 * Filter graph (4K, before the camera move) placing input `fg` as a bordered, tilted print with
 * a soft shadow over a blurred, darkened copy of itself, with input `under` (optional) as an
 * older print beneath it. Ends in [print].
 */
export function printComposeFilter(tilt: number, hasUnder: boolean): string {
  const a = (tilt * Math.PI) / 180;
  const ua = ((-Math.sign(tilt || 1) * 4.5) * Math.PI) / 180;
  const card = (src: string, scale: number, angle: number, out: string) =>
    `[${src}]scale=w=${Math.round(3840 * scale)}:h=${Math.round(2160 * scale)}:force_original_aspect_ratio=decrease,` +
    `pad=w=iw+110:h=ih+110:x=55:y=55:color=0x${BORDER},format=rgba,` +
    `rotate=a=${angle.toFixed(4)}:c=none:ow=rotw(${angle.toFixed(4)}):oh=roth(${angle.toFixed(4)})[${out}]`;
  const parts = [
    '[0:v]split=2[bgsrc][fgsrc]',
    '[bgsrc]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,gblur=sigma=42,eq=brightness=-0.16:saturation=0.55[bg]',
    card('fgsrc', 0.8, a, 'card'),
    '[card]split=2[card1][card2]',
    // Shadow: the card's alpha, blackened and blurred, offset down-right
    '[card2]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.55,boxblur=luma_radius=28:luma_power=2:alpha_radius=28:alpha_power=2[shadow]',
  ];
  let base = 'bg';
  if (hasUnder) {
    parts.push(
      card('1:v', 0.72, ua, 'ucard'),
      '[ucard]colorchannelmixer=rr=0.72:gg=0.72:bb=0.72[udim]',
      '[bg][udim]overlay=x=(W-w)/2-190:y=(H-h)/2-120[bgu]',
    );
    base = 'bgu';
  }
  parts.push(`[${base}][shadow]overlay=x=(W-w)/2+34:y=(H-h)/2+52[bgs]`, '[bgs][card1]overlay=x=(W-w)/2:y=(H-h)/2,format=yuv420p[print]');
  return parts.join(';');
}

/**
 * A warm light leak as a transparent layer: a soft glow drifting in from the left that fades out
 * by 1.6 s. Drawn at low resolution and scaled up (it is all blur), so it costs almost nothing,
 * and laid over only for its own length.
 */
const LEAK_SEC = 1.6;
const leakSource = () => {
  const fade = `(1-min(1,T/${LEAK_SEC}))`;
  const glow = `exp(-(pow(X-(40+90*T),2)+pow(Y-(70+20*T),2))/5200)`;
  return (
    `color=c=black:s=480x270:r=${FPS}:d=${LEAK_SEC},format=rgba,` +
    `geq=r='255':g='150+60*${glow}':b='70':a='200*${glow}*${fade}',gblur=sigma=18,scale=1920:1080:flags=bicubic`
  );
};

/**
 * Grain (and an optional light leak) over a 1080p stream `in`, ending in `out`. Grain is input
 * `grainIdx` (looped). The grain changes brightness only (colour planes pass through untouched,
 * which also keeps it cheap); the leak is drawn inline and overlaid for its first 1.6 s.
 */
export function textureOverlayFilter(input: string, out: string, grainIdx: number, leak = false): string {
  const parts = [
    `[${grainIdx}:v]format=yuv420p,setsar=1[grain]`,
    `[${input}]format=yuv420p,setsar=1[base]`,
    // ffmpeg's "normal" mode at opacity 1 keeps the top input (the footage's own colour); at 0 it
    // would take the grain's neutral grey and drain the colour
    '[base][grain]blend=c0_mode=overlay:c0_opacity=0.55:c1_mode=normal:c1_opacity=1:c2_mode=normal:c2_opacity=1:shortest=1[grained]',
  ];
  if (leak) parts.push(`${leakSource()}[leak]`, `[grained][leak]overlay=eof_action=pass:format=auto[${out}]`);
  else parts.push(`[grained]null[${out}]`);
  return parts.join(';');
}

/**
 * Projector gate weave and a gentle flicker for old film: a 1-2 px wander from layered slow
 * sines (cropped and scaled back so the edges never show) and a small brightness wobble.
 */
export const GATE_WEAVE_FILTER =
  "crop=w=1892:h=1064:x='14+2.2*sin(n*0.61)+1.1*sin(n*1.73)':y='8+1.6*sin(n*0.47+1)+0.9*sin(n*2.11)'," +
  "scale=1920:1080:flags=bicubic,eq=brightness='0.012*sin(n*1.9)+0.008*sin(n*5.3)':eval=frame";
