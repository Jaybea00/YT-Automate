import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath, getFfprobePath } from '../utils/ffmpeg';
import { measureLoudness, TARGET_LUFS, TARGET_TRUE_PEAK } from './master';

const execFileAsync = promisify(execFile);

/**
 * The final quality check on the finished video: one decoding pass finds black frames, a frozen
 * picture and silences; then loudness, format and sync are checked. Intended dips at section
 * changes and the closing fade aren't flagged. The report is saved on the video and shown on the
 * progress page.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface QualityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface QualityReport {
  checkedAt: string;
  /** No check failed (warnings allowed). */
  passed: boolean;
  checks: QualityCheck[];
}

export interface Interval {
  start: number;
  end: number;
}

/** A dip this close to a section change is the intended transition, not a fault. */
const DIP_TOLERANCE_SEC = 0.9;
const END_FADE_SEC = 1.5;
const BLACK_MIN_SEC = 0.4;
const FREEZE_MIN_SEC = 4;
const SILENCE_MIN_SEC = 2.5;
const SILENCE_FAIL_SEC = 4;

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const list = (xs: Interval[]) => xs.slice(0, 5).map((x) => `${fmt(x.start)} (${(x.end - x.start).toFixed(1)}s)`).join(', ') + (xs.length > 5 ? `, +${xs.length - 5} more` : '');

/** Parses black, freeze and silence intervals from ffmpeg's detector output. */
export function parseDetections(stderr: string): { black: Interval[]; freeze: Interval[]; silence: Interval[] } {
  const black = [...stderr.matchAll(/black_start:(-?[\d.]+) black_end:(-?[\d.]+)/g)].map((m) => ({ start: +m[1], end: +m[2] }));
  const pair = (startRe: RegExp, endRe: RegExp): Interval[] => {
    const starts = [...stderr.matchAll(startRe)].map((m) => +m[1]);
    const ends = [...stderr.matchAll(endRe)].map((m) => +m[1]);
    return starts.map((start, i) => ({ start, end: ends[i] ?? Number.POSITIVE_INFINITY }));
  };
  return {
    black,
    freeze: pair(/freeze_start: (-?[\d.]+)/g, /freeze_end: (-?[\d.]+)/g),
    silence: pair(/silence_start: (-?[\d.]+)/g, /silence_end: (-?[\d.]+)/g),
  };
}

/** Black stretches that aren't an intended dip at a section change or the closing fade. */
export function unintendedBlack(black: Interval[], sectionChangesSec: number[], durationSec: number): Interval[] {
  return black.filter(
    (b) =>
      b.end - b.start >= BLACK_MIN_SEC &&
      b.start < durationSec - END_FADE_SEC &&
      !sectionChangesSec.some((c) => b.start >= c - DIP_TOLERANCE_SEC && b.end <= c + DIP_TOLERANCE_SEC),
  );
}

interface StreamInfo {
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

export async function runFinalQualityCheck(
  videoPath: string,
  options: { sectionChangesSec?: number[]; expectedDurationSec?: number } = {},
): Promise<QualityReport> {
  const checks: QualityCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });

  // Format and sync
  const { stdout } = await execFileAsync(getFfprobePath(), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels,duration:format=duration', '-of', 'json', videoPath]);
  const probe = JSON.parse(stdout) as { streams: StreamInfo[]; format: { duration?: string } };
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  const durationSec = Number.parseFloat(probe.format.duration ?? '0');
  const formatOk = v?.codec_name === 'h264' && v.width === 1920 && v.height === 1080 && v.pix_fmt === 'yuv420p' && v.r_frame_rate === '30/1' && a?.codec_name === 'aac' && a.sample_rate === '48000';
  add('format', 'Format', formatOk ? 'pass' : 'fail',
    `${v?.codec_name ?? 'no video'} ${v?.width}x${v?.height} ${v?.pix_fmt} ${v?.r_frame_rate} fps · ${a?.codec_name ?? 'no audio'} ${a?.sample_rate} Hz ${a?.channels} ch`);

  const vDur = Number.parseFloat(v?.duration ?? '0');
  const aDur = Number.parseFloat(a?.duration ?? '0');
  const drift = Math.abs(vDur - aDur);
  add('sync', 'Picture and sound in sync', drift <= 0.2 ? 'pass' : drift <= 0.5 ? 'warn' : 'fail', `picture ${vDur.toFixed(2)}s, sound ${aDur.toFixed(2)}s`);

  if (options.expectedDurationSec) {
    const off = Math.abs(durationSec - options.expectedDurationSec);
    add('length', 'Length matches the edit', off <= 0.5 ? 'pass' : off <= 2 ? 'warn' : 'fail', `${fmt(durationSec)} (edit: ${fmt(options.expectedDurationSec)})`);
  }

  // Loudness against YouTube's reference
  const loud = await measureLoudness(videoPath);
  const lufs = Number.parseFloat(loud.input_i);
  const peak = Number.parseFloat(loud.input_tp);
  const lufsOff = Math.abs(lufs - TARGET_LUFS);
  add('loudness', 'Loudness (YouTube -14 LUFS)', lufsOff <= 1 ? 'pass' : lufsOff <= 2 ? 'warn' : 'fail', `${lufs.toFixed(1)} LUFS`);
  add('peaks', 'Peaks (no clipping)', peak <= TARGET_TRUE_PEAK + 0.1 ? 'pass' : peak <= -0.3 ? 'warn' : 'fail', `true peak ${peak.toFixed(1)} dBTP`);

  // One decoding pass for black frames, a frozen picture and silences
  const { stderr } = await execFileAsync(
    getFfmpegPath(),
    ['-hide_banner', '-nostats', '-i', videoPath,
      '-vf', `blackdetect=d=${BLACK_MIN_SEC}:pix_th=0.10,freezedetect=n=0.001:d=${FREEZE_MIN_SEC}`,
      '-af', `silencedetect=noise=-45dB:d=${SILENCE_MIN_SEC}`,
      '-f', 'null', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const found = parseDetections(stderr);

  const black = unintendedBlack(found.black, options.sectionChangesSec ?? [], durationSec);
  add('black', 'No unexpected black frames', black.length === 0 ? 'pass' : black.some((b) => b.end - b.start > 1) ? 'fail' : 'warn',
    black.length ? `at ${list(black)}` : `${found.black.length} intended dip${found.black.length === 1 ? '' : 's'} only`);

  const freeze = found.freeze.filter((f) => f.start < durationSec - END_FADE_SEC);
  add('freeze', 'Picture keeps moving', freeze.length === 0 ? 'pass' : 'warn', freeze.length ? `still for ${FREEZE_MIN_SEC}s+ at ${list(freeze.map((f) => ({ ...f, end: Math.min(f.end, durationSec) })))}` : 'no frozen stretches');

  const silence = found.silence.map((s) => ({ ...s, end: Math.min(s.end, durationSec) })).filter((s) => s.start < durationSec - END_FADE_SEC);
  add('silence', 'No dead air', silence.length === 0 ? 'pass' : silence.some((s) => s.end - s.start > SILENCE_FAIL_SEC) ? 'fail' : 'warn',
    silence.length ? `silent at ${list(silence)}` : 'no long silences');

  return { checkedAt: new Date().toISOString(), passed: !checks.some((c) => c.status === 'fail'), checks };
}
