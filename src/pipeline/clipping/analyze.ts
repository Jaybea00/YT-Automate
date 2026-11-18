import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath, getFfprobePath } from '../utils/ffmpeg';
import { LOUDNESS_STEP, type ClipAnalysis, type ClipWord } from './types';

const execFileAsync = promisify(execFile);

// --------------------------------------------------------------------------
// Probe
// --------------------------------------------------------------------------

export async function probeClip(file: string): Promise<{ durationSec: number; width: number; height: number; hasAudio: boolean }> {
  const { stdout } = await execFileAsync(getFfprobePath(), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file]);
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const durationSec = Number.parseFloat(data.format?.duration ?? '');
  if (!video || !Number.isFinite(durationSec) || durationSec <= 0) throw new Error('The downloaded file has no playable video');
  return { durationSec, width: video.width ?? 0, height: video.height ?? 0, hasAudio: Boolean(data.streams?.some((s) => s.codec_type === 'audio')) };
}

// --------------------------------------------------------------------------
// Loudness and loud moments
// --------------------------------------------------------------------------

/** ffmpeg's per-window RMS readings (astats + ametadata print) as dB values. */
export function parseLoudness(stdout: string): number[] {
  const values: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(\S+)/);
    if (!m) continue;
    const v = Number.parseFloat(m[1]);
    values.push(Number.isFinite(v) ? Math.max(-90, v) : -90);
  }
  return values;
}

export async function measureLoudness(file: string): Promise<number[]> {
  const samples = Math.round(48000 * LOUDNESS_STEP);
  const { stdout } = await execFileAsync(
    getFfmpegPath(),
    ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-af', `aresample=48000,asetnsamples=n=${samples}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, '-f', 'null', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return parseLoudness(stdout);
}

const median = (xs: number[]) => {
  if (!xs.length) return -90;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Loud moments (explosions, crashes, shouting): readings well above the clip's usual level that
 * stand out from the second before them. Strongest first, at least `minGapSec` apart.
 */
export function findPeaks(loudness: number[], step = LOUDNESS_STEP, options: { max?: number; minGapSec?: number; minRiseDb?: number } = {}): Array<{ at: number; score: number }> {
  // Gameplay sound is often compressed flat: when nothing rises 6 dB, smaller rises still count
  for (const rise of options.minRiseDb != null ? [options.minRiseDb] : [6, 3.5, 2]) {
    const found = peaksAbove(loudness, step, options.max ?? 5, options.minGapSec ?? 3, rise);
    if (found.length) return found;
  }
  return [];
}

function peaksAbove(loudness: number[], step: number, max: number, minGapSec: number, minRiseDb: number): Array<{ at: number; score: number }> {
  const usual = median(loudness.filter((v) => v > -80));
  const candidates: Array<{ at: number; score: number }> = [];
  for (let i = 0; i < loudness.length; i++) {
    const v = loudness[i];
    if (v < usual + minRiseDb) continue;
    const near = loudness.slice(Math.max(0, i - 2), i + 3);
    if (v < Math.max(...near)) continue; // not the top of its bump
    const before = loudness.slice(Math.max(0, i - 4), i);
    const jump = before.length ? Math.max(0, v - before.reduce((a, b) => a + b, 0) / before.length) : 0;
    candidates.push({ at: Number((i * step).toFixed(2)), score: Number((v - usual + jump).toFixed(1)) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked: Array<{ at: number; score: number }> = [];
  for (const c of candidates) {
    if (picked.every((p) => Math.abs(p.at - c.at) >= minGapSec)) picked.push(c);
    if (picked.length >= max) break;
  }
  return picked;
}

// --------------------------------------------------------------------------
// Speech (Whisper, run locally)
// --------------------------------------------------------------------------

/** Phrases Whisper invents over noise and silence. */
const HALLUCINATION = /^(thanks?( you)? (so much )?for watching|please subscribe|subscribe|like and subscribe|thank you\.?|you|bye\.?|subtitles by.*|transcribed by.*|amara\.org.*)$/i;
const MUSIC_MARK = /♪|🎵|\[(music|singing)\]|\((music|singing)\)|^\s*\[?music\]?\s*$/i;
/** A word longer than this is Whisper stretching the last word over a silence. */
const MAX_WORD_SEC = 1.2;

interface WhisperChunk {
  text: string;
  timestamp: [number, number | null];
}

/**
 * Whisper's word chunks made usable: music marks become music stretches, invented phrases and
 * long runs of one repeated word (Whisper looping over noise) are dropped, and words stretched
 * over a silence are cut back.
 */
export function cleanTranscript(chunks: WhisperChunk[], durationSec: number): { words: ClipWord[]; musicSections: Array<{ start: number; end: number }> } {
  const music: Array<{ start: number; end: number }> = [];
  const raw: ClipWord[] = [];
  for (const c of chunks) {
    const start = Math.max(0, c.timestamp[0] ?? 0);
    const end = Math.min(durationSec, c.timestamp[1] ?? start + 0.4);
    const text = c.text.trim();
    if (!text) continue;
    if (MUSIC_MARK.test(text)) {
      music.push({ start, end: Math.max(end, start + 1) });
      continue;
    }
    raw.push({ word: text, start, end: Math.min(end, start + MAX_WORD_SEC) });
  }

  // Whole invented phrases: rebuild sentences (split at pauses) and test each
  const words: ClipWord[] = [];
  let sentence: ClipWord[] = [];
  const flush = () => {
    const text = sentence.map((w) => w.word).join(' ').replace(/[.!?,]+$/, '').trim();
    if (sentence.length && !HALLUCINATION.test(text)) words.push(...sentence);
    sentence = [];
  };
  for (const w of raw) {
    const prev = sentence[sentence.length - 1];
    if (prev && w.start - prev.end > 0.8) flush();
    sentence.push(w);
  }
  flush();

  // Runs of the same word repeated five or more times
  const kept: ClipWord[] = [];
  for (let i = 0; i < words.length; ) {
    let j = i;
    const key = (w: ClipWord) => w.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    while (j < words.length && key(words[j]) === key(words[i])) j++;
    if (j - i < 5) kept.push(...words.slice(i, j));
    i = j;
  }

  return { words: kept, musicSections: mergeSpans(music, 2) };
}

export function mergeSpans(spans: Array<{ start: number; end: number }>, joinGapSec: number): Array<{ start: number; end: number }> {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= joinGapSec) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

type Asr = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string; chunks?: WhisperChunk[] }>;
const globalForAsr = globalThis as unknown as { __clipAsr?: Promise<Asr> };

export const whisperModel = () => process.env.WHISPER_MODEL || 'onnx-community/whisper-base_timestamped';

async function loadAsr(): Promise<Asr> {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'models');
  return (await pipeline('automatic-speech-recognition', whisperModel(), { dtype: 'q8' })) as unknown as Asr;
}

/** 16 kHz mono samples, the way Whisper takes them. */
async function decodeAudio(file: string): Promise<Float32Array> {
  const { stdout } = await execFileAsync(getFfmpegPath(), ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 1024,
  });
  const buf = stdout as unknown as Buffer;
  // Copied so the samples start on a 4-byte boundary
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
}

export async function transcribe(file: string, durationSec: number): Promise<{ words: ClipWord[]; transcript: string; musicSections: Array<{ start: number; end: number }> }> {
  globalForAsr.__clipAsr ??= loadAsr().catch((err) => {
    globalForAsr.__clipAsr = undefined;
    throw err;
  });
  const asr = await globalForAsr.__clipAsr;
  const audio = await decodeAudio(file);
  const out = await asr(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, language: 'english', task: 'transcribe' });
  const { words, musicSections } = cleanTranscript(out.chunks ?? [], durationSec);
  return { words, musicSections, transcript: words.map((w) => w.word).join(' ') };
}

// --------------------------------------------------------------------------
// Stills for the script writer
// --------------------------------------------------------------------------

/** When to take stills: spread across the clip, plus one at each loud moment. */
export function frameTimes(durationSec: number, peaks: Array<{ at: number }>, count = 10, max = 14): number[] {
  const spread = Array.from({ length: count }, (_, i) => ((i + 0.5) * durationSec) / count);
  const all = [...spread, ...peaks.slice(0, 4).map((p) => p.at)].map((t) => Math.min(Math.max(0, t), Math.max(0, durationSec - 0.1))).sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of all) if (out.every((o) => Math.abs(o - t) >= 0.8)) out.push(Number(t.toFixed(2)));
  return out.slice(0, max);
}

async function extractFrames(file: string, dir: string, times: number[]): Promise<Array<{ at: number; file: string }>> {
  await fs.mkdir(path.join(dir, 'frames'), { recursive: true });
  const out: Array<{ at: number; file: string }> = [];
  for (const [i, at] of times.entries()) {
    const name = `frames/f${String(i).padStart(2, '0')}.jpg`;
    try {
      await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', path.join(dir, name)]);
      out.push({ at, file: name });
    } catch {
      // a still past the last frame: skip it
    }
  }
  return out;
}

// --------------------------------------------------------------------------

/** Everything the script writer and the editor need to know about the clip. */
export async function analyzeClip(dir: string, sourceFile: string, onStep: (step: string) => Promise<void> | void = () => {}): Promise<{ analysis: ClipAnalysis; warnings: string[] }> {
  const file = path.join(dir, sourceFile);
  const warnings: string[] = [];
  const info = await probeClip(file);

  let loudness: number[] = [];
  let peaks: ClipAnalysis['peaks'] = [];
  let words: ClipWord[] = [];
  let transcript = '';
  let musicSections: ClipAnalysis['musicSections'] = [];

  if (info.hasAudio) {
    await onStep('Measuring loud moments');
    loudness = await measureLoudness(file).catch((err) => {
      warnings.push(`Loudness could not be measured: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      return [];
    });
    peaks = findPeaks(loudness);

    await onStep('Listening for dialogue (Whisper)');
    try {
      ({ words, transcript, musicSections } = await transcribe(file, info.durationSec));
    } catch (err) {
      warnings.push(`Dialogue could not be transcribed, so there are no dialogue captions: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
    if (musicSections.length) {
      warnings.push(`Possible music at ${musicSections.map((m) => `${m.start.toFixed(0)}–${m.end.toFixed(0)}s`).join(', ')}. In-game radio songs can get a Content ID claim: consider "Mute music".`);
    }
  } else {
    warnings.push('The clip has no sound.');
  }

  await onStep('Taking stills');
  const frames = await extractFrames(file, dir, frameTimes(info.durationSec, peaks));

  return { analysis: { ...info, loudness, peaks, words, transcript, musicSections, frames }, warnings };
}
