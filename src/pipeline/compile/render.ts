import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatAssTime, generateAssCaptions } from '../assembly/captions';
import { ensureSoundLibrary, soundPath } from '../assembly/sfx';
import { maskSwear, stripEmoji } from '../clipping/render';
import { getFfmpegPath } from '../utils/ffmpeg';
import type { Compilation, CompilationItem, ItemAnalysis } from './types';

const execFileAsync = promisify(execFile);

const FPS = 30;
export const SIZE = { short: { w: 1080, h: 1920 }, long: { w: 1920, h: 1080 } } as const;
const fx = (n: number) => n.toFixed(3);

async function ffmpeg(args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync(getFfmpegPath(), ['-y', '-hide_banner', '-v', 'error', ...args], { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60_000 });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    throw new Error(`ffmpeg failed: ${(stderr || (err instanceof Error ? err.message : String(err))).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  }
}

/** Same encoding for every piece, so they can be joined without re-encoding. */
const ENCODE = ['-c:v', 'libx264', '-preset', 'faster', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-video_track_timescale', '15360', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];

// --------------------------------------------------------------------------
// Text overlays (ASS)
// --------------------------------------------------------------------------

export interface OverlayLine {
  style: 'Tag' | 'CardBig' | 'CardSub' | 'CardTitle';
  text: string;
  startMs: number;
  endMs: number;
}

/** Text that is safe inside an ASS line (no override braces, no emoji the font can't draw). */
export const assText = (s: string) => stripEmoji(s).replace(/[{}\\]/g, '').replace(/\n/g, '\\N').trim();

/** Name tags and card text: top-left tag, big centred number, title and subtitle. */
export function overlayAss(width: number, height: number, lines: OverlayLine[]): string {
  const s = height / 1080; // sizes are designed for 1080 tall and scaled for other canvases
  const short = height > width;
  const tagSize = Math.round((short ? 30 : 34) * s);
  const style = (name: string, font: string, size: number, primary: string, outline: number, border: 1 | 3, back: string, align: number, mL: number, mR: number, mV: number) =>
    `Style: ${name}, ${font}, ${size}, ${primary}, &H00FFFFFF, &H00101010, ${back}, -1, 0, 0, 0, 100, 100, 0, 0, ${border}, ${outline}, 0, ${align}, ${mL}, ${mR}, ${mV}, 1`;
  return `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${style('Tag', 'Segoe UI Semibold', tagSize, '&H00FFFFFF', Math.round(10 * s), 3, '&H80000000', 7, Math.round(40 * s), 40, Math.round((short ? 200 : 40) * s))}
${style('CardBig', 'Segoe UI Black', Math.round(260 * s), '&H0000D4FF', Math.round(8 * s), 1, '&H00000000', 5, 60, 60, 0)}
${style('CardTitle', 'Segoe UI Black', Math.round(96 * s), '&H00FFFFFF', Math.round(6 * s), 1, '&H00000000', 5, 120, 120, 0)}
${style('CardSub', 'Segoe UI Semibold', Math.round(54 * s), '&H00FFFFFF', Math.round(4 * s), 1, '&H00000000', 2, 160, 160, Math.round(220 * s))}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines
  .filter((l) => assText(l.text) && l.endMs > l.startMs)
  .map((l) => `Dialogue: 1,${formatAssTime(l.startMs)},${formatAssTime(l.endMs)},${l.style},,0,0,0,,${l.style === 'CardBig' || l.style === 'CardTitle' ? '{\\fad(150,150)}' : ''}${assText(l.text)}`)
  .join('\n')}
`;
}

// --------------------------------------------------------------------------
// Filter graphs (pure)
// --------------------------------------------------------------------------

/** The picture fitted to the canvas: cropped to fill, or whole over a blurred copy of itself. */
export function frameFilter(input: string, w: number, h: number, crop: boolean, out: string): string {
  if (crop) return `${input}fps=${FPS},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1${out}`;
  return (
    `${input}fps=${FPS},split=2[bg][fg];` +
    `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=30,eq=brightness=-0.15[bgb];` +
    `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1[fgs];` +
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1${out}`
  );
}

/** A clip piece's sound: its own sound evened out (or silence), a whoosh at the cut, gentle fades. */
export function clipAudioFilter(hasAudio: boolean, durationSec: number, whooshInput: number | null): string {
  const norm = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const game = hasAudio
    ? `[0:a]${norm},loudnorm=I=-16:TP=-1.5:LRA=11,${norm},apad,atrim=0:${fx(durationSec)}[game]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${fx(durationSec)}[game]`;
  const fadeOut = Math.max(0, durationSec - 0.12);
  const finish = `afade=t=in:st=0:d=0.05,afade=t=out:st=${fx(fadeOut)}:d=0.12[a]`;
  if (whooshInput == null) return `${game};[game]${finish}`;
  return `${game};[${whooshInput}:a]${norm},volume=0.35[wh];[game][wh]amix=inputs=2:normalize=0:duration=first,${finish}`;
}

// --------------------------------------------------------------------------
// Pieces
// --------------------------------------------------------------------------

async function renderClipPiece(opts: {
  workDir: string;
  out: string;
  item: CompilationItem;
  analysis: ItemAnalysis;
  c: Compilation;
  index: number;
}): Promise<number> {
  const { workDir, out, item, analysis, c, index } = opts;
  const { w, h } = SIZE[c.format];
  const durationSec = Math.max(1, Math.min(item.end, analysis.durationSec) - item.start);
  const n = c.items.length;

  // Captions (dialogue) and banners (the hook on the first clip of a Short)
  const words = c.options.captions
    ? analysis.words
        .filter((wd) => wd.start >= item.start && wd.end <= item.start + durationSec + 0.2)
        .map((wd) => ({ word: c.options.cleanCaptions ? maskSwear(wd.word) : wd.word, start: wd.start - item.start, end: wd.end - item.start }))
    : [];
  const short = c.format === 'short';
  const { assContent } = generateAssCaptions({
    beats: [{ index: 0, text: '' }],
    units: [{ unit_index: 0, duration_ms: Math.round(durationSec * 1000) }],
    beatStartMs: [0],
    words: { 0: words },
    preset: 'social_pop',
    highlightHex: '#ffd400',
    resolution: { width: w, height: h },
    fontSize: short ? 78 : 62,
    marginV: short ? 420 : 90,
    banners: short && index === 0 && stripEmoji(c.hook) ? [{ text: stripEmoji(c.hook), startMs: 0, endMs: Math.round(Math.min(2.5, durationSec) * 1000), position: 'top' }] : [],
  });
  const tag = c.options.nameCards && item.creator ? (short ? item.creator : `#${n - index}  ·  ${item.creator}`) : '';
  const caps = `caps_${index}.ass`;
  const tags = `tag_${index}.ass`;
  await fs.writeFile(path.join(workDir, caps), assContent, 'utf-8');
  await fs.writeFile(path.join(workDir, tags), overlayAss(w, h, tag ? [{ style: 'Tag', text: tag, startMs: short && index === 0 ? 2600 : 200, endMs: Math.round(durationSec * 1000) }] : []), 'utf-8');

  const fadeOut = Math.max(0, durationSec - 0.12);
  const video = `${frameFilter('[0:v]', w, h, short ? c.options.crop : false, '[fr]')};[fr]ass=${caps},ass=${tags},fade=t=in:st=0:d=0.08,fade=t=out:st=${fx(fadeOut)}:d=0.12,format=yuv420p[v]`;
  await ffmpeg(
    [
      '-ss', fx(item.start), '-t', fx(durationSec), '-i', item.file,
      '-i', soundPath('whoosh'),
      '-filter_complex', `${video};${clipAudioFilter(analysis.hasAudio, durationSec, 1)}`,
      '-map', '[v]', '-map', '[a]', '-t', fx(durationSec), ...ENCODE, out,
    ],
    workDir,
  );
  return durationSec;
}

/** A long-form card: a blurred, darkened still with big text, the voice line (or a whoosh). */
async function renderCard(opts: {
  workDir: string;
  out: string;
  stillFrom: { file: string; at: number };
  lines: OverlayLine[];
  voiceFile: string | null;
  voiceSec: number;
  minSec: number;
  name: string;
}): Promise<number> {
  const { workDir, out, stillFrom, voiceFile, voiceSec, name } = opts;
  const { w, h } = SIZE.long;
  const durationSec = Math.max(opts.minSec, voiceFile ? voiceSec + 0.9 : 0);
  const still = path.join(workDir, `${name}.jpg`);
  await ffmpeg(['-ss', fx(Math.max(0, stillFrom.at)), '-i', stillFrom.file, '-frames:v', '1', '-q:v', '3', still], workDir).catch(async () => {
    // A file too short to seek into: its first frame
    await ffmpeg(['-i', stillFrom.file, '-frames:v', '1', '-q:v', '3', still], workDir);
  });
  const ass = `${name}.ass`;
  await fs.writeFile(path.join(workDir, ass), overlayAss(w, h, opts.lines.map((l) => ({ ...l, endMs: Math.min(l.endMs, Math.round(durationSec * 1000)) }))), 'utf-8');
  const fadeOut = Math.max(0, durationSec - 0.2);
  const video =
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=25,eq=brightness=-0.28:saturation=0.8,setsar=1,` +
    `ass=${ass},fade=t=in:st=0:d=0.2,fade=t=out:st=${fx(fadeOut)}:d=0.2,format=yuv420p[v]`;
  const norm = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const audio = voiceFile
    ? `[1:a]${norm},volume=0.3[wh];[2:a]${norm},adelay=350|350,volume=1.3[vo];anullsrc=r=48000:cl=stereo,atrim=0:${fx(durationSec)}[sil];[sil][wh][vo]amix=inputs=3:normalize=0:duration=first,alimiter=limit=0.95:level=disabled[a]`
    : `[1:a]${norm},volume=0.35[wh];anullsrc=r=48000:cl=stereo,atrim=0:${fx(durationSec)}[sil];[sil][wh]amix=inputs=2:normalize=0:duration=first[a]`;
  await ffmpeg(
    [
      '-loop', '1', '-framerate', String(FPS), '-t', fx(durationSec), '-i', still,
      '-i', soundPath('whoosh'),
      ...(voiceFile ? ['-i', voiceFile] : []),
      '-filter_complex', `${video};${audio}`,
      '-map', '[v]', '-map', '[a]', '-t', fx(durationSec), ...ENCODE, out,
    ],
    workDir,
  );
  return durationSec;
}

// --------------------------------------------------------------------------
// The whole video
// --------------------------------------------------------------------------

export async function renderCompilation(
  dir: string,
  c: Compilation,
  onProgress: (done: number, total: number) => Promise<void> | void = () => {},
): Promise<{ video: string; thumbnail: string; durationSec: number }> {
  if (!c.items.length) throw new Error('The compilation has no clips');
  const workDir = path.join(dir, 'work');
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(path.join(dir, 'export'), { recursive: true });
  await ensureSoundLibrary();

  const n = c.items.length;
  const long = c.format === 'long';
  const pieces: string[] = [];
  const total = n + (long ? n + 2 : 0);
  let done = 0;
  let durationSec = 0;
  const voiceOf = (key: string) => (c.options.voiceover && c.voice[key] ? { file: path.join(dir, c.voice[key].file), sec: c.voice[key].durationSec } : null);
  const piece = (name: string) => path.join(workDir, `${String(pieces.length).padStart(3, '0')}_${name}.mp4`);

  if (long) {
    const v = voiceOf('intro');
    const out = piece('intro');
    durationSec += await renderCard({
      workDir, out, name: 'intro', voiceFile: v?.file ?? null, voiceSec: v?.sec ?? 0, minSec: 3,
      stillFrom: { file: c.items[n - 1].file, at: c.items[n - 1].start + 1 },
      lines: [
        { style: 'CardTitle', text: c.titles[0] || c.theme, startMs: 150, endMs: 60_000 },
        { style: 'CardSub', text: `${n} clips`, startMs: 400, endMs: 60_000 },
      ],
    });
    pieces.push(out);
    await onProgress(++done, total);
  }

  for (const [i, item] of c.items.entries()) {
    const analysis = c.analysis[item.key];
    if (!analysis) throw new Error(`Clip ${i + 1} was not analysed`);
    if (long) {
      const v = voiceOf(item.key);
      const out = piece(`card${i}`);
      durationSec += await renderCard({
        workDir, out, name: `card${i}`, voiceFile: v?.file ?? null, voiceSec: v?.sec ?? 0, minSec: 2.2,
        stillFrom: { file: item.file, at: item.start + 0.5 },
        lines: [
          { style: 'CardBig', text: `#${n - i}`, startMs: 100, endMs: 60_000 },
          { style: 'CardSub', text: item.label, startMs: 300, endMs: 60_000 },
        ],
      });
      pieces.push(out);
      await onProgress(++done, total);
    }
    const out = piece(`clip${i}`);
    durationSec += await renderClipPiece({ workDir, out, item, analysis, c, index: i });
    pieces.push(out);
    await onProgress(++done, total);
  }

  if (long) {
    const v = voiceOf('outro');
    const out = piece('outro');
    durationSec += await renderCard({
      workDir, out, name: 'outro', voiceFile: v?.file ?? null, voiceSec: v?.sec ?? 0, minSec: 3,
      stillFrom: { file: c.items[0].file, at: c.items[0].start + 1 },
      lines: [
        { style: 'CardTitle', text: 'Thanks for watching', startMs: 150, endMs: 60_000 },
        { style: 'CardSub', text: 'Which one was your favourite?', startMs: 400, endMs: 60_000 },
      ],
    });
    pieces.push(out);
    await onProgress(++done, total);
  }

  // Joined without re-encoding (every piece was encoded the same way)
  const list = path.join(workDir, 'pieces.txt');
  await fs.writeFile(list, pieces.map((p) => `file '${path.basename(p)}'`).join('\n'), 'utf-8');
  const tmp = path.join(dir, 'export', 'compilation.rendering.mp4');
  const final = path.join(dir, 'export', 'compilation.mp4');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', 'pieces.txt', '-c', 'copy', '-movflags', '+faststart', tmp], workDir);
  await fs.rename(tmp, final);

  // Thumbnail: the best clip (shown last) at its loudest moment
  const best = c.items[n - 1];
  const peak = c.analysis[best.key]?.peakSec;
  const at = peak != null && peak >= best.start && peak <= best.end ? peak : best.start + (best.end - best.start) / 2;
  const { w, h } = SIZE[c.format];
  await ffmpeg(['-ss', fx(at), '-i', best.file, '-frames:v', '1', '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`, '-q:v', '2', path.join(dir, 'export', 'thumbnail.jpg')], workDir).catch(() => {});

  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  return { video: 'export/compilation.mp4', thumbnail: 'export/thumbnail.jpg', durationSec: Math.round(durationSec * 100) / 100 };
}
