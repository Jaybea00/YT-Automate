import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import { withEncoder } from '../utils/video-encoder';
import { loudnessCorrectionFilter, measureLoudness } from './master';
import type { Interval, QualityReport } from './final-check';

const execFileAsync = promisify(execFile);

/**
 * Fixes for what the final check finds, made on the finished file without changing its length
 * (captions, chapters, subtitles, Shorts and the music stems are all timed to it):
 * - loudness or peaks off target: the sound is mastered again;
 * - picture and sound out of step: the sound is padded or trimmed to the picture;
 * - a short unexpected black flash: covered with the frame just before it;
 * - wrong format (size, frame rate, pixel format): the picture is re-encoded to 1080p30.
 * Dead air and a frozen picture are left to the creator: removing either would change the
 * video's length, or need new footage.
 */

/** A black flash longer than this is a missing shot, not a glitch: covering it with a held frame would look worse. */
export const MAX_BLACK_TO_COVER_SEC = 2;

/** A big gain change can push peaks past -1 dBTP; this holds them just under it without changing loudness. */
export const PEAK_LIMITER = 'alimiter=limit=0.85:attack=2:release=50:level=0';

export interface PlannedFixes {
  loudness: boolean;
  sync: boolean;
  black: Interval[];
  format: boolean;
}

const notPassing = (report: QualityReport, id: string) => report.checks.some((c) => c.id === id && c.status !== 'pass');

/** Which fixes a report calls for. */
export function planFixes(report: QualityReport): PlannedFixes {
  const black = notPassing(report, 'black') ? (report.found?.black ?? []).filter((b) => Number.isFinite(b.end) && b.end - b.start <= MAX_BLACK_TO_COVER_SEC) : [];
  return {
    loudness: notPassing(report, 'loudness') || notPassing(report, 'peaks'),
    sync: notPassing(report, 'sync') && Boolean(report.found?.videoSec),
    black,
    format: notPassing(report, 'format'),
  };
}

export const hasFixes = (f: PlannedFixes) => f.loudness || f.sync || f.black.length > 0 || f.format;

/** What a fix will do, in words for the report. */
export function describeFixes(f: PlannedFixes, report: QualityReport): Array<{ id: string; detail: string }> {
  const out: Array<{ id: string; detail: string }> = [];
  const was = (id: string) => report.checks.find((c) => c.id === id)?.detail ?? '';
  if (f.loudness) out.push({ id: 'loudness', detail: `Sound mastered again (was ${[was('loudness'), was('peaks')].filter(Boolean).join(', ')}).` });
  if (f.sync) out.push({ id: 'sync', detail: `Sound fitted to the picture's length (was ${was('sync')}).` });
  if (f.black.length) {
    const at = f.black.map((b) => `${Math.floor(b.start / 60)}:${(b.start % 60).toFixed(1).padStart(4, '0')}`).join(', ');
    out.push({ id: 'black', detail: `${f.black.length} black flash${f.black.length === 1 ? '' : 'es'} covered with the frame before (at ${at}).` });
  }
  if (f.format) out.push({ id: 'format', detail: `Picture re-encoded to 1080p, 30 fps (was ${was('format')}).` });
  return out;
}

/**
 * The ffmpeg filter that lays each held frame over its black flash. Input 0 is the video; inputs
 * from `firstInput` are the held frames, one per flash, in order.
 */
export function coverGraph(black: Interval[], firstInput: number, format: boolean): string {
  const n3 = (x: number) => x.toFixed(3);
  const tail = format ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p' : 'format=yuv420p';
  if (!black.length) return `[0:v]${tail}[vout]`;
  const parts = black.map((b, i) => {
    const prev = i === 0 ? '0:v' : `c${i - 1}`;
    return `[${firstInput + i}:v]scale=1920:1080,format=yuv420p[h${i}];[${prev}][h${i}]overlay=eof_action=pass:enable='between(t,${n3(b.start)},${n3(b.end)})'[c${i}]`;
  });
  return [...parts, `[c${black.length - 1}]${tail}[vout]`].join(';');
}

/** The frame to hold over a flash: just before it, or just after when it opens the video. */
export const holdFrameAt = (b: Interval) => (b.start > 0.15 ? b.start - 0.1 : b.end + 0.1);

/**
 * Applies the fixes, writing a new file beside the video. Returns its path, or null when there
 * was nothing to fix.
 */
export async function applyFixes(videoPath: string, fixes: PlannedFixes, report: QualityReport, outputPath: string): Promise<string | null> {
  if (!hasFixes(fixes)) return null;
  const tmpDir = path.join(path.dirname(outputPath), `fix_${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    const holds: string[] = [];
    for (const [i, b] of fixes.black.entries()) {
      const png = path.join(tmpDir, `hold${i}.png`);
      await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', holdFrameAt(b).toFixed(3), '-i', videoPath, '-frames:v', '1', png]);
      holds.push(png);
    }
    const redoPicture = holds.length > 0 || fixes.format;
    const af: string[] = [];
    if (fixes.loudness) af.push(loudnessCorrectionFilter(await measureLoudness(videoPath)), 'aresample=48000', PEAK_LIMITER);
    if (fixes.sync) af.push('apad');
    const videoSec = report.found?.videoSec ?? 0;

    const args = ['-y', '-i', videoPath];
    for (const [i, png] of holds.entries()) args.push('-loop', '1', '-framerate', '30', '-t', (fixes.black[i].end + 0.1).toFixed(3), '-i', png);
    const VIDEO = '@video';
    if (redoPicture) args.push('-filter_complex', coverGraph(fixes.black, 1, fixes.format), '-map', '[vout]', VIDEO, '-r', '30');
    else args.push('-map', '0:v:0', '-c:v', 'copy');
    args.push('-map', '0:a:0');
    if (af.length) args.push('-af', af.join(','), '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2');
    else args.push('-c:a', 'copy');
    // Never longer or shorter than the picture
    if (videoSec > 0) args.push('-t', videoSec.toFixed(3));
    args.push('-movflags', '+faststart', outputPath);

    const run = (videoArgs: string[]) =>
      execFileAsync(getFfmpegPath(), args.flatMap((a) => (a === VIDEO ? videoArgs : [a])), { maxBuffer: 16 * 1024 * 1024 });
    if (redoPicture) await withEncoder('master', run);
    else await run([]);
    return outputPath;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
