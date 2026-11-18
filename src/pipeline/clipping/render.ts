import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateAssCaptions } from '../assembly/captions';
import { ensureSoundLibrary, soundPath } from '../assembly/sfx';
import { getFfmpegPath } from '../utils/ffmpeg';
import type { ClipAnalysis, ClipLayout, ClipPlan, ClipWord } from './types';

const execFileAsync = promisify(execFile);

export const SHORT_W = 1080;
export const SHORT_H = 1920;
const FPS = 30;
/** How much the picture punches in on the big moment. */
const ZOOM = 0.14;
/** Game sound under a voice line, and under music the user muted. */
const DUCK_GAIN = 0.28;

type Span = { start: number; end: number };
const fx = (n: number) => n.toFixed(3);

// --------------------------------------------------------------------------
// Filter graphs (pure, so they can be checked without ffmpeg)
// --------------------------------------------------------------------------

/** Zoom factor over time: a quick punch-in just before the peak, held, then eased back. */
export function zoomExpression(peakSec: number, amount = ZOOM, timeVar = 'in/30'): string {
  const a = Math.max(0, peakSec - 0.12);
  const b = peakSec + 0.08;
  const c = peakSec + 1.4;
  const e = peakSec + 1.9;
  return `1+${amount}*min(clip((${timeVar}-${fx(a)})/${fx(b - a)},0,1),clip((${fx(e)}-${timeVar})/${fx(e - c)},0,1))`;
}

export function videoFilter(options: { layout: ClipLayout; durationSec: number; peakSec: number | null; zoom: boolean; assFile: string }): string {
  const { layout, durationSec, peakSec, zoom, assFile } = options;
  const base =
    layout === 'crop'
      ? `[0:v]fps=${FPS},scale=${SHORT_W}:${SHORT_H}:force_original_aspect_ratio=increase,crop=${SHORT_W}:${SHORT_H},setsar=1[base]`
      : // fit and original: the whole picture over a blurred, darkened copy of itself
        `[0:v]fps=${FPS},split=2[bg][fg];` +
        `[bg]scale=${SHORT_W}:${SHORT_H}:force_original_aspect_ratio=increase,crop=${SHORT_W}:${SHORT_H},gblur=sigma=30,eq=brightness=-0.12[bgb];` +
        `[fg]scale=${SHORT_W}:${SHORT_H}:force_original_aspect_ratio=decrease,setsar=1[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`;
  const zoomed = zoom && peakSec != null && peakSec < durationSec
    ? `[base]zoompan=z='${zoomExpression(peakSec)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${SHORT_W}x${SHORT_H}:fps=${FPS}[zb]`
    : `[base]null[zb]`;
  const fadeOut = Math.max(0, durationSec - 0.3);
  return `${base};${zoomed};[zb]ass=${assFile},fade=t=in:st=0:d=0.15,fade=t=out:st=${fx(fadeOut)}:d=0.3,format=yuv420p[v]`;
}

/** The game sound's volume over time: silent where music is muted, lowered under voice lines. */
export function gameVolumeExpression(duck: Span[], mute: Span[]): string {
  const parts = [
    ...mute.map((s) => `if(between(t,${fx(s.start)},${fx(s.end)}),0,1)`),
    ...duck.map((s) => `if(between(t,${fx(s.start)},${fx(s.end)}),${DUCK_GAIN},1)`),
  ];
  return parts.length ? parts.join('*') : '1';
}

export function audioFilter(options: {
  hasAudio: boolean;
  durationSec: number;
  duck: Span[];
  mute: Span[];
  /** Input index and start (seconds) of each voice line. */
  voices: Array<{ input: number; atSec: number }>;
  sfx: { input: number; atSec: number } | null;
}): string {
  const { hasAudio, durationSec, duck, mute, voices, sfx } = options;
  const norm = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const chains: string[] = [];
  chains.push(
    hasAudio
      ? `[0:a]${norm},volume='${gameVolumeExpression(duck, mute)}':eval=frame[game]`
      : `anullsrc=r=48000:cl=stereo,atrim=0:${fx(durationSec)}[game]`,
  );
  const labels = ['[game]'];
  for (const [i, v] of voices.entries()) {
    const ms = Math.max(0, Math.round(v.atSec * 1000));
    chains.push(`[${v.input}:a]${norm},adelay=${ms}|${ms},volume=1.3[vo${i}]`);
    labels.push(`[vo${i}]`);
  }
  if (sfx) {
    const ms = Math.max(0, Math.round(sfx.atSec * 1000));
    chains.push(`[${sfx.input}:a]${norm},adelay=${ms}|${ms},volume=0.55[sfx]`);
    labels.push('[sfx]');
  }
  const fadeOut = Math.max(0, durationSec - 0.3);
  const finish = `alimiter=limit=0.95:level=disabled,afade=t=in:st=0:d=0.1,afade=t=out:st=${fx(fadeOut)}:d=0.3[a]`;
  chains.push(
    labels.length > 1
      ? `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first:dropout_transition=0,${finish}`
      : `[game]${finish}`,
  );
  return chains.join(';');
}

/** Emoji have no glyphs in the caption fonts (they render as boxes), so on-screen text drops them. */
export const stripEmoji = (s: string) => s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s{2,}/g, ' ').trim();

const SWEAR = /^(fuck|fucking|fuckin|fucked|fucker|motherfuck\w*|shit\w*|bitch\w*|bastard|asshole|dick|cunt|nigg\w*|pussy)$/i;

/** "fuck!" -> "f***!": the first letter kept, punctuation kept. */
export function maskSwear(word: string): string {
  const m = word.match(/^([^\p{L}]*)([\p{L}']+)([^\p{L}]*)$/u);
  if (!m || !SWEAR.test(m[2].replace(/'/g, ''))) return word;
  return `${m[1]}${m[2][0]}${'*'.repeat(Math.min(4, m[2].length - 1))}${m[3]}`;
}

/** Caption words (dialogue and voiceover) and banners (hook, on-screen texts), timed from the Short's start. */
export function captionTrack(plan: ClipPlan, analysis: ClipAnalysis): { words: ClipWord[]; banners: Array<{ text: string; startMs: number; endMs: number; position: 'top' }> } {
  const t0 = plan.trimStart;
  const dur = plan.trimEnd - plan.trimStart;
  const words: ClipWord[] = [];
  if (plan.captions) {
    for (const w of analysis.words) if (w.start >= t0 && w.end <= plan.trimEnd + 0.2) words.push({ word: w.word, start: w.start - t0, end: w.end - t0 });
    if (plan.voiceover) {
      for (const line of plan.voiceLines) {
        if (!line.audioFile || !line.words) continue;
        for (const w of line.words) words.push({ word: w.word, start: line.at - t0 + w.start, end: line.at - t0 + w.end });
      }
    }
  }
  words.sort((a, b) => a.start - b.start);
  if (plan.cleanCaptions !== false) for (const w of words) w.word = maskSwear(w.word);
  const banners: Array<{ text: string; startMs: number; endMs: number; position: 'top' }> = [];
  if (plan.showHook && stripEmoji(plan.hook)) banners.push({ text: stripEmoji(plan.hook), startMs: 0, endMs: Math.round(Math.min(plan.hookSec, dur) * 1000), position: 'top' });
  for (const o of plan.overlays) {
    const text = stripEmoji(o.text);
    if (text && o.until > t0 && o.at < plan.trimEnd) banners.push({ text, startMs: Math.round(Math.max(0, o.at - t0) * 1000), endMs: Math.round(Math.min(dur, o.until - t0) * 1000), position: 'top' });
  }
  return { words: words.filter((w) => w.start >= 0 && w.end <= dur + 0.2), banners };
}

// --------------------------------------------------------------------------
// Render
// --------------------------------------------------------------------------

export async function renderShort(dir: string, sourceFile: string, plan: ClipPlan, analysis: ClipAnalysis): Promise<{ video: string; thumbnail: string; durationSec: number }> {
  const durationSec = Math.max(1, plan.trimEnd - plan.trimStart);
  await fs.mkdir(path.join(dir, 'export'), { recursive: true });

  // Captions and banners
  const { words, banners } = captionTrack(plan, analysis);
  const { assContent } = generateAssCaptions({
    beats: [{ index: 0, text: '' }],
    units: [{ unit_index: 0, duration_ms: Math.round(durationSec * 1000) }],
    beatStartMs: [0],
    words: { 0: words },
    preset: 'social_pop',
    highlightHex: '#ffd400',
    resolution: { width: SHORT_W, height: SHORT_H },
    fontSize: 80,
    marginV: 420,
    banners,
  });
  const assName = 'short.ass';
  await fs.writeFile(path.join(dir, assName), assContent, 'utf-8');

  // Inputs: the clip, then each voiced line, then the impact sound
  const inputs = ['-ss', fx(plan.trimStart), '-t', fx(durationSec), '-i', path.join(dir, sourceFile)];
  const rel = (sec: number) => sec - plan.trimStart;
  const voices: Array<{ input: number; atSec: number }> = [];
  const duck: Span[] = [];
  if (plan.voiceover) {
    for (const line of plan.voiceLines) {
      if (!line.audioFile || rel(line.at) < 0 || rel(line.at) >= durationSec) continue;
      voices.push({ input: 1 + voices.length, atSec: rel(line.at) });
      inputs.push('-i', path.join(dir, line.audioFile));
      duck.push({ start: Math.max(0, rel(line.at) - 0.1), end: rel(line.at) + (line.durationSec ?? 2) + 0.15 });
    }
  }
  let sfx: { input: number; atSec: number } | null = null;
  if (plan.sfxOnPeak && plan.peakSec != null && rel(plan.peakSec) >= 0 && rel(plan.peakSec) < durationSec) {
    await ensureSoundLibrary();
    sfx = { input: 1 + voices.length, atSec: Math.max(0, rel(plan.peakSec) - 0.05) };
    inputs.push('-i', soundPath('impact'));
  }
  const mute = plan.muteMusic ? analysis.musicSections.map((m) => ({ start: Math.max(0, rel(m.start)), end: rel(m.end) })).filter((m) => m.end > 0) : [];

  const peakRel = plan.peakSec != null ? rel(plan.peakSec) : null;
  const graph = [
    videoFilter({ layout: plan.layout, durationSec, peakSec: peakRel != null && peakRel >= 0 ? peakRel : null, zoom: plan.zoomOnPeak, assFile: assName }),
    audioFilter({ hasAudio: analysis.hasAudio, durationSec, duck, mute, voices, sfx }),
  ].join(';');

  const tmp = path.join(dir, 'export', 'short.rendering.mp4');
  const out = path.join(dir, 'export', 'short.mp4');
  try {
    await execFileAsync(
      getFfmpegPath(),
      [
        '-y', '-hide_banner', '-v', 'error', ...inputs,
        '-filter_complex', graph,
        '-map', '[v]', '-map', '[a]',
        '-t', fx(durationSec),
        '-c:v', 'libx264', '-preset', 'faster', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(FPS),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', tmp,
      ],
      { cwd: dir, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60_000 },
    );
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    throw new Error(`The render failed: ${(stderr || (err instanceof Error ? err.message : String(err))).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  } finally {
    await fs.unlink(path.join(dir, assName)).catch(() => {});
  }
  await fs.rename(tmp, out);

  // Thumbnail: the big moment, or the middle
  const thumbAt = peakRel != null && peakRel >= 0 && peakRel < durationSec ? peakRel + 0.2 : durationSec / 2;
  const thumb = path.join(dir, 'export', 'thumbnail.jpg');
  await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', fx(Math.min(thumbAt, durationSec - 0.1)), '-i', out, '-frames:v', '1', '-q:v', '2', thumb]).catch(() => {});

  return { video: 'export/short.mp4', thumbnail: 'export/thumbnail.jpg', durationSec: Number(durationSec.toFixed(2)) };
}
