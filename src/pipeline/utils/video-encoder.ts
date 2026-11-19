import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from './ffmpeg';

const execFileAsync = promisify(execFile);

/**
 * Which encoder makes the picture. Intel's Quick Sync (the graphics chip in most laptops) joins
 * scenes with transitions about 1.4x faster than x264 at the same quality (measured: 7.0 s vs
 * 9.6 s for 36 s of 1080p, SSIM 0.995 between the two), so the joins (the slowest step of a long
 * render) use it when the machine has it. Anything that fails on the graphics chip is encoded again
 * in software, so a render never fails because of it.
 *
 * Software stays for the rest: scene clips (cut-only styles join them by stream copy, and mixing
 * two encoders' streams in one copy-join can glitch on playback) and previews (x264 ultrafast at
 * half size beat Quick Sync there). Decoding on the chip was tried too and made joins slower.
 *
 * VIDEO_ENCODER=auto (default) | software | hardware. VIDEO_ENCODER_MASTER=software (default) |
 * hardware for the final picture as well.
 */

export type EncodePurpose = 'scene' | 'join' | 'draft' | 'master';
export type EncoderKind = 'software' | 'hardware';

const SOFTWARE: Record<EncodePurpose, string[]> = {
  scene: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-color_range', 'tv'],
  join: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-color_range', 'tv'],
  draft: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart'],
  master: ['-c:v', 'libx264', '-preset', 'faster', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart'],
};

/** Quick Sync settings: global_quality is its quality scale (lower is better), measured to match x264 closely. */
const HARDWARE: Record<EncodePurpose, string[]> = {
  scene: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '16', '-pix_fmt', 'nv12', '-color_range', 'tv'],
  join: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '16', '-pix_fmt', 'nv12', '-color_range', 'tv'],
  draft: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '28', '-pix_fmt', 'nv12', '-color_range', 'tv', '-movflags', '+faststart'],
  master: ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '18', '-pix_fmt', 'nv12', '-color_range', 'tv', '-movflags', '+faststart'],
};

export function encodeArgs(purpose: EncodePurpose, kind: EncoderKind): string[] {
  return [...(kind === 'hardware' ? HARDWARE : SOFTWARE)[purpose]];
}

/** Whether a purpose may use the graphics chip, by the settings (before checking the machine has one). */
export function hardwareAllowed(purpose: EncodePurpose, env: Record<string, string | undefined> = process.env): boolean {
  const setting = (env.VIDEO_ENCODER ?? 'auto').trim().toLowerCase();
  if (setting === 'software') return false;
  if (purpose === 'scene' || purpose === 'draft') return false;
  if (purpose === 'master') return (env.VIDEO_ENCODER_MASTER ?? 'software').trim().toLowerCase() === 'hardware';
  return true;
}

const probe = globalThis as unknown as { __qsvProbe?: Promise<boolean> };

/** Does this machine's ffmpeg encode on Quick Sync? Tried once with a tiny clip. */
export function hardwareEncoderWorks(): Promise<boolean> {
  probe.__qsvProbe ??= execFileAsync(
    getFfmpegPath(),
    ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=0.2', ...HARDWARE.join, '-f', 'null', '-'],
    { timeout: 20_000 },
  ).then(
    () => true,
    () => false,
  );
  return probe.__qsvProbe;
}

export async function chooseEncoder(purpose: EncodePurpose): Promise<EncoderKind> {
  return hardwareAllowed(purpose) && (await hardwareEncoderWorks()) ? 'hardware' : 'software';
}

/** Counts of what each encode used this process (for the render report). */
const tally = globalThis as unknown as { __encodeTally?: { hardware: number; software: number; fellBack: number } };
export function encodeTally() {
  tally.__encodeTally ??= { hardware: 0, software: 0, fellBack: 0 };
  return tally.__encodeTally;
}

/**
 * Runs an encode with the best encoder for its purpose. `run` gets the picture-encode arguments
 * to splice into its ffmpeg command; a failure on the graphics chip is retried in software.
 */
export async function withEncoder<T>(purpose: EncodePurpose, run: (videoArgs: string[], kind: EncoderKind) => Promise<T>): Promise<T> {
  const kind = await chooseEncoder(purpose);
  const t = encodeTally();
  if (kind === 'software') {
    t.software++;
    return run(encodeArgs(purpose, 'software'), 'software');
  }
  try {
    const out = await run(encodeArgs(purpose, 'hardware'), 'hardware');
    t.hardware++;
    return out;
  } catch (err) {
    console.warn(`[encoder] Quick Sync failed for a ${purpose} encode, encoding in software instead: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    t.fellBack++;
    return run(encodeArgs(purpose, 'software'), 'software');
  }
}
