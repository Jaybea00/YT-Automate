import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { getFfmpegPath } from '../utils/ffmpeg';
import { guideFile } from './store';
import { cropFor, FPS, isStill, toFrames, type Cut, type Segment } from './timeline';
import type { FootageInfo } from './types';
import { GRADE_FILTER } from '../clipping/reaction';

/** A picture laid over the footage (a title, card, label or note), on the video's clock. */
export interface BasePicture {
  /** The PNG (drawn before the footage is rendered). */
  file: string;
  /** What the picture is (its HTML): part of a part's cache name, since the PNG is drawn again each time. */
  key: string;
  from: number;
  to: number;
  /** Overlay position (W, H: the frame; w, h: the picture). */
  x?: string;
  y: string | number;
  /** Fade in and out (seconds). */
  fade?: number;
  /** Slide in from the left edge to x=0 instead of sitting at x. */
  slide?: boolean;
}

interface BaseOptions {
  width: number;
  height: number;
  gameVolume: number;
  /** Punchier colour, under the pictures. */
  grade?: boolean;
  pictures?: BasePicture[];
}

const execFileAsync = promisify(execFile);
const fx = (n: number) => n.toFixed(3);
const NORM = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

/**
 * The guide's footage as one track: every cut cropped, timed and with its own sound at its level,
 * rendered one part at a time (so ffmpeg never has hundreds of recordings open at once) and joined.
 * Parts are kept in render-base/ under a name made from everything that shapes them, so a re-render
 * only redoes the parts that changed. Video is near-lossless, sound uncompressed, so the joins are exact.
 */
export async function renderBaseTrack(
  dir: string,
  segments: Segment[],
  footage: Map<string, FootageInfo>,
  o: BaseOptions,
): Promise<string> {
  const work = path.join(dir, 'render-base');
  await fs.mkdir(work, { recursive: true });
  const parts: string[] = [];
  // The pictures' pixels go into each part's name, so a picture drawn differently re-renders its parts
  const pixels = new Map<string, string>();
  for (const x of o.pictures ?? []) if (!pixels.has(x.file)) pixels.set(x.file, createHash('sha1').update(await fs.readFile(x.file)).digest('hex').slice(0, 12));
  for (const [k, s] of segments.entries()) {
    // The pictures over this part, on its own clock
    const end = s.start + s.durationSec;
    const pics = (o.pictures ?? [])
      .filter((x) => x.to > x.from && x.from < end && x.to > s.start)
      .map((x) => ({ ...x, from: Math.max(0, x.from - s.start), to: Math.min(s.durationSec, x.to - s.start) }));
    const key = createHash('sha1')
      .update(JSON.stringify({ cuts: s.cuts, w: o.width, h: o.height, g: o.gameVolume, grade: !!o.grade, pics: pics.map(({ file, ...x }) => ({ ...x, px: pixels.get(file) })), v: 3 }))
      .digest('hex')
      .slice(0, 12);
    const file = path.join(work, `part-${key}.mkv`);
    parts.push(file);
    if (await fs.stat(file).then((x) => x.size > 0).catch(() => false)) continue;
    console.log(`[Guide] Footage for part ${k + 1}/${segments.length} (${s.part}, ${s.cuts.length} cuts)`);
    await renderPart(dir, s.cuts, footage, o, pics, file);
  }
  const list = path.join(work, 'parts.txt');
  await fs.writeFile(list, parts.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8');
  const base = path.join(work, 'base.mkv');
  await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', base], { maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60_000 });
  return base;
}

/** One part's cuts, end to end, into `out`. */
async function renderPart(dir: string, cuts: Cut[], footage: Map<string, FootageInfo>, o: BaseOptions, pics: BasePicture[], out: string): Promise<void> {
  const W = o.width;
  const H = o.height;
  const inputs: string[] = [];
  const chains: string[] = [];
  const pieces: string[] = [];
  let next = 0;
  const input = (file: string, from: number, sec: number) => {
    if (isStill(file)) inputs.push('-loop', '1', '-framerate', String(FPS), '-t', fx(sec + 0.2), '-i', guideFile(dir, file));
    else inputs.push('-ss', fx(from), '-t', fx(sec + 0.2), '-i', guideFile(dir, file));
    return next++;
  };
  /** A recording's stretch cropped to w×h and timed to fill the cut. */
  const picture = (i: number, file: string, srcSec: number, outSec: number, w: number, h: number, focusX?: number, zoom?: number, focusY?: number) => {
    const info = footage.get(file)!;
    const crop = cropFor(info, focusX, zoom, focusY, w / h);
    const stretch = isStill(file) ? 1 : outSec / Math.max(0.01, srcSec);
    return `[${i}:v]setpts=(PTS-STARTPTS)*${stretch.toFixed(4)},fps=${FPS},crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${w}:${h}:flags=lanczos,setsar=1`;
  };
  for (const [n, c] of cuts.entries()) {
    const frames = toFrames(c.outSec);
    const i = input(c.file, c.from, isStill(c.file) ? c.outSec : c.srcSec);
    const push = c.push ? `,zoompan=z='1+${c.push}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}` : '';
    const end = `tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames}`;
    if (c.beside) {
      // Side by side: this cut on the left, its partner on the right, a thin line between
      const j = input(c.beside.file, c.beside.from, isStill(c.beside.file) ? c.outSec : c.beside.srcSec);
      const half = Math.floor(W / 2 / 2) * 2;
      chains.push(`${picture(i, c.file, c.srcSec, c.outSec, half - 4, H, c.focusX, c.zoom, c.focusY)},${end}[l${n}]`);
      chains.push(`${picture(j, c.beside.file, c.beside.srcSec, c.outSec, W - half - 4, H, c.beside.focusX, c.beside.zoom, c.beside.focusY)},${end}[r${n}]`);
      chains.push(`[l${n}]pad=${half}:${H}:0:0:black[lp${n}];[r${n}]pad=${W - half}:${H}:4:0:black[rp${n}];[lp${n}][rp${n}]hstack=inputs=2${push},setpts=PTS-STARTPTS[v${n}]`);
    } else chains.push(`${picture(i, c.file, c.srcSec, c.outSec, W, H, c.focusX, c.zoom, c.focusY)},${end}${push},setpts=PTS-STARTPTS[v${n}]`);
    const info = footage.get(c.file)!;
    const vol = Math.max(0, Math.min(1, c.volume ?? o.gameVolume));
    chains.push(
      info.hasAudio && !c.mute && !isStill(c.file)
        ? `[${i}:a]${NORM},asetpts=PTS-STARTPTS,apad,atrim=duration=${fx(frames / FPS)},asetpts=PTS-STARTPTS,volume=${vol}[a${n}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${fx(frames / FPS)}[a${n}]`,
    );
    pieces.push(`[v${n}][a${n}]`);
  }
  chains.push(`${pieces.join('')}concat=n=${pieces.length}:v=1:a=1[cv][a]`);
  // The colour, then the pictures on top
  let label = '[pk0]';
  chains.push(`[cv]${o.grade ? GRADE_FILTER : 'null'}${label}`);
  for (const [k, x] of pics.entries()) {
    const i = next++;
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', fx(x.to - x.from + 0.1), '-i', x.file);
    const fade = x.fade ?? 0.1;
    const F = fx(x.from);
    const xExpr = x.slide ? `if(lt(t-${F},0.35),-w+(t-${F})/0.35*w,0)` : (x.x ?? '(W-w)/2');
    const outLabel = `[pk${k + 1}]`;
    chains.push(
      `[${i}:v]format=rgba,setpts=PTS-STARTPTS+${F}/TB,${x.from > 0 ? `fade=t=in:st=${F}:d=${fade}:alpha=1,` : ''}fade=t=out:st=${fx(Math.max(x.from, x.to - fade))}:d=${fade}:alpha=1[pic${k}];` +
        `${label}[pic${k}]overlay=x='${xExpr}':y='${x.y}':eof_action=pass:enable='between(t,${F},${fx(x.to)})'${outLabel}`,
    );
    label = outLabel;
  }
  chains.push(`${label}format=yuv420p[v]`);
  const graph = `${out}.filter`;
  await fs.writeFile(graph, chains.join(';\n'), 'utf-8');
  try {
    await execFileAsync(
      getFfmpegPath(),
      ['-y', '-hide_banner', '-v', 'error', ...inputs, '-/filter_complex', graph, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'pcm_s16le', '-ar', '48000', out],
      { cwd: dir, maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000 },
    );
  } catch (err) {
    await fs.unlink(out).catch(() => {});
    const stderr = (err as { stderr?: string }).stderr ?? '';
    throw new Error(`Rendering the footage failed: ${(stderr || (err instanceof Error ? err.message : String(err))).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  } finally {
    await fs.unlink(graph).catch(() => {});
  }
}

/**
 * Lays sounds out on one track (each at its moment and volume, overlaps added) and writes it as a
 * WAV, so the final mix has one input for all of them instead of one per line or whoosh.
 */
export async function mixBus(entries: Array<{ file: string; atSec: number; volume: number }>, durationSec: number, out: string): Promise<void> {
  const RATE = 48000;
  const total = Math.ceil(durationSec * RATE) * 2;
  const mix = new Float32Array(total);
  for (const e of entries) {
    const { stdout } = await execFileAsync(getFfmpegPath(), ['-v', 'error', '-i', e.file, '-f', 'f32le', '-ac', '2', '-ar', String(RATE), 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
    const buf = stdout as unknown as Buffer;
    const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    const at = Math.max(0, Math.round(e.atSec * RATE)) * 2;
    const n = Math.min(samples.length, total - at);
    for (let i = 0; i < n; i++) mix[at + i] += samples[i] * e.volume;
  }
  // A 32-bit float WAV
  const data = Buffer.from(mix.buffer, mix.byteOffset, mix.byteLength);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(3, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2 * 4, 28);
  head.writeUInt16LE(2 * 4, 32);
  head.writeUInt16LE(32, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  await fs.writeFile(out, Buffer.concat([head, data]));
}
