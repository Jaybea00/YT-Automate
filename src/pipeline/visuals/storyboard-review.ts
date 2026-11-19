import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import { clipModel, cosine, embedText } from './local-look';
import { shotThumbnail, type StoryboardShot } from './storyboard';

const execFileAsync = promisify(execFile);

/**
 * Storyboard review: problems only visible across shots, which checking each shot alone can't
 * catch: near-identical shots side by side, black-and-white next to colour, stills held too long,
 * busy text or a broadcaster's logo on screen, gaps where nothing was found, and footage the
 * channel already showed in other videos.
 */

export type StoryboardIssueKind = 'duplicate' | 'era_jump' | 'long_still' | 'text_or_logo' | 'gap' | 'needs_check' | 'reused';

export const ISSUE_LABEL: Record<StoryboardIssueKind, string> = {
  duplicate: 'Looks like the shot before',
  era_jump: 'Black-and-white next to colour',
  long_still: 'Still held too long',
  text_or_logo: 'Busy text or a logo',
  gap: 'No footage found (shown as type)',
  needs_check: 'Not checked for relevance yet',
  reused: 'Used in other videos',
};

export interface StoryboardIssue {
  order: number;
  beatIndex: number;
  shotIndex: number;
  kind: StoryboardIssueKind;
  severity: 'high' | 'medium' | 'info';
  detail: string;
}

/** What is measured from each shot's middle frame. */
export interface ShotLook {
  /** 64-bit difference hash, as 16 hex characters. */
  hash: string;
  /** Mean colour saturation, 0 (grey) to 1. */
  saturation: number;
  /** Chance the frame is mostly text, a logo or a broadcast, 0-1 (footage shots only). */
  textOrLogo?: number;
}

const FOOTAGE = new Set(['stock', 'archive', 'illustration', 'uploaded']);
const isFootage = (s: StoryboardShot) => FOOTAGE.has(s.renderedType) && !s.fallback;
/** Hash distance (out of 64) at or below which two frames look the same. */
export const SAME_FRAME_DISTANCE = 10;
export const LONG_STILL_SEC = 7;
const GREY = 0.07;
const COLOUR = 0.22;
const TEXT_OR_LOGO = 0.6;

export function hammingHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** A difference hash from a 9x8 greyscale image (72 bytes): each bit says "brighter than its right neighbour". */
export function dHash(gray9x8: Uint8Array): string {
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray9x8[y * 9 + x] > gray9x8[y * 9 + x + 1] ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** Mean HSV saturation of RGB pixels. */
export function meanSaturation(rgb: Uint8Array): number {
  let sum = 0;
  const n = Math.floor(rgb.length / 3);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    sum += max === 0 ? 0 : (max - min) / max;
  }
  return n ? Math.round((sum / n) * 1000) / 1000 : 0;
}

async function rawFrame(image: string, size: string, pixFmt: 'gray' | 'rgb24'): Promise<Uint8Array> {
  const { stdout } = await execFileAsync(getFfmpegPath(), ['-v', 'error', '-i', image, '-vf', `scale=${size}:flags=area`, '-f', 'rawvideo', '-pix_fmt', pixFmt, '-'], {
    encoding: 'buffer',
    maxBuffer: 1 << 20,
  });
  return new Uint8Array(stdout as unknown as Buffer);
}

const TEXT_LABELS = ['a frame filled with large text or a headline', 'a TV news broadcast with a channel logo and ticker', 'a page of printed text', 'a picture with a watermark logo across it'];
const PLAIN_LABELS = ['a photograph of a scene', 'a film still', 'a photo of people or a place'];

/** Chance (0-1) the image is mostly text, a logo or a broadcast, by comparing it with descriptions of each. */
async function textOrLogoChance(thumb: string): Promise<number> {
  const model = await clipModel();
  const image = await model.image(new Uint8Array(await fs.readFile(thumb)));
  const sims = await Promise.all([...TEXT_LABELS, ...PLAIN_LABELS].map(async (l) => cosine(image, await embedText(l))));
  const exp = sims.map((s) => Math.exp(100 * s));
  const total = exp.reduce((a, b) => a + b, 0);
  return Math.round((exp.slice(0, TEXT_LABELS.length).reduce((a, b) => a + b, 0) / total) * 100) / 100;
}

/** Measures a shot's look from its middle frame, reusing the saved measurement while the clip is unchanged. */
export async function measureShot(shot: StoryboardShot, useModel: boolean): Promise<ShotLook> {
  const cache = `${shot.clipPath}.look.json`;
  const clip = await fs.stat(shot.clipPath);
  const saved = await fs.readFile(cache, 'utf-8').then((t) => JSON.parse(t) as ShotLook & { clipMtime: number }).catch(() => null);
  if (saved && saved.clipMtime === clip.mtimeMs && (!useModel || !isFootage(shot) || saved.textOrLogo !== undefined)) return saved;
  const thumb = await shotThumbnail(shot.clipPath);
  const look: ShotLook = {
    hash: dHash(await rawFrame(thumb, '9:8', 'gray')),
    saturation: meanSaturation(await rawFrame(thumb, '32:18', 'rgb24')),
    ...(useModel && isFootage(shot) ? { textOrLogo: await textOrLogoChance(thumb).catch(() => undefined) } : {}),
  };
  await fs.writeFile(cache, JSON.stringify({ ...look, clipMtime: clip.mtimeMs }), 'utf-8');
  return look;
}

/** The problems in a storyboard, in shot order. */
export function reviewStoryboard(shots: StoryboardShot[], looks: Map<number, ShotLook>, usedElsewhere: (sourceUrl: string) => number = () => 0): StoryboardIssue[] {
  const issues: StoryboardIssue[] = [];
  const add = (s: StoryboardShot, kind: StoryboardIssueKind, severity: StoryboardIssue['severity'], detail: string) =>
    issues.push({ order: s.order, beatIndex: s.beatIndex, shotIndex: s.shotIndex, kind, severity, detail });
  shots.forEach((s, i) => {
    const prev = shots[i - 1];
    const look = looks.get(s.order);
    const prevLook = prev ? looks.get(prev.order) : undefined;
    if (prev && look && prevLook && isFootage(s) && isFootage(prev)) {
      const d = hammingHex(look.hash, prevLook.hash);
      if (d <= SAME_FRAME_DISTANCE) add(s, 'duplicate', 'high', `Almost the same picture as the shot before (difference ${d}/64).`);
      const grey = (l: ShotLook) => l.saturation < GREY;
      const colour = (l: ShotLook) => l.saturation > COLOUR;
      if (prev.beatIndex === s.beatIndex && ((grey(look) && colour(prevLook)) || (colour(look) && grey(prevLook)))) {
        add(s, 'era_jump', 'medium', 'Black-and-white and colour footage cut together in one beat looks like two eras.');
      }
    }
    if (s.still && isFootage(s) && s.durationSec > LONG_STILL_SEC) add(s, 'long_still', 'medium', `A still photo on screen for ${s.durationSec.toFixed(1)}s.`);
    if (look?.textOrLogo !== undefined && look.textOrLogo >= TEXT_OR_LOGO) add(s, 'text_or_logo', 'high', `Looks like text, a logo or a broadcast (${Math.round(look.textOrLogo * 100)}%): may clash with captions or be someone's branding.`);
    if (s.fallback) add(s, 'gap', 'medium', 'Nothing fitting was found, so the words are shown as type.');
    if (s.needsCheck) add(s, 'needs_check', 'info', 'Picked without the relevance check; pick again once the check is available.');
    const reused = s.sourceUrl ? usedElsewhere(s.sourceUrl) : 0;
    if (reused > 0) add(s, 'reused', 'info', `This footage is also in ${reused} other video${reused === 1 ? '' : 's'} on the channel.`);
  });
  return issues;
}
