import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import { findEmojiImage, isEmojiChar } from './emojis';
import { libraryMatches, listLibrary } from './memes';
import { ENDING_DEFAULTS } from './reaction';
import type { ClipPlan, SoundFile } from './types';

const execFileAsync = promisify(execFile);

/**
 * Meme sounds (vine boom, bruh, sad violin, record scratch…) for moments and endings, from:
 *   1. the sound library, storage/sounds: your own downloads, named by what they are ("vine-boom.mp3")
 *   2. a few built-in sounds made here, so a Short gets its boom even with an empty library
 * Each is normalised into the clip folder (a short WAV), so a render never depends on the library.
 */

export const soundLibraryDir = () => process.env.SOUND_LIBRARY_DIR || path.join(process.cwd(), 'storage', 'sounds');
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|opus|flac|mp4|webm)$/i;
/** Sounds longer than this are cut (an ending song, a long violin). */
const MAX_SOUND_SEC = 8;

/** Built-in sounds, made with ffmpeg: names they answer to, and how they are made. */
export const BUILTIN_SOUNDS: Array<{ id: string; names: string[]; recipe: string }> = [
  {
    id: 'boom',
    names: ['boom', 'vine boom', 'bass boom', 'bass drop', 'thud'],
    recipe: "aevalsrc='0.95*sin(2*PI*(58*t-18*t*t))*exp(-3.2*t)+0.5*sin(2*PI*(116*t-36*t*t))*exp(-6*t)+0.25*(random(0)*2-1)*exp(-40*t)':s=48000:d=1.6,lowpass=f=900,aecho=0.8:0.6:60|120:0.35|0.2,volume=1.6",
  },
  {
    id: 'ding',
    names: ['ding', 'bell', 'correct', 'success'],
    recipe: "aevalsrc='0.5*(sin(2*PI*1568*t)+0.5*sin(2*PI*3136*t)+0.25*sin(2*PI*4704*t))*exp(-4*t)':s=48000:d=1.4",
  },
  {
    id: 'riser',
    names: ['riser', 'build up', 'tension', 'suspense'],
    recipe: "aevalsrc='0.35*sin(2*PI*(200*t+300*t*t))*(t/1.2)+0.15*(random(0)*2-1)*(t/1.2)':s=48000:d=1.2,highpass=f=150",
  },
  {
    id: 'scratch',
    names: ['record scratch', 'scratch', 'rewind', 'wait what'],
    recipe: "aevalsrc='0.7*(random(0)*2-1)*sin(2*PI*(9*t))*exp(-2.5*t)':s=48000:d=0.55,bandpass=f=1400:w=1800,volume=1.8",
  },
];

/** The built-in sound a query names, if any (whole words only: "boom" yes, "boomer" no). */
export function builtinFor(query: string): (typeof BUILTIN_SOUNDS)[number] | null {
  const q = ` ${query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  let best: (typeof BUILTIN_SOUNDS)[number] | null = null;
  let bestLen = 0;
  for (const s of BUILTIN_SOUNDS) for (const n of s.names) if (q.includes(` ${n} `) && n.length > bestLen) [best, bestLen] = [s, n.length];
  return best;
}

export const soundKey = (query: string) => query.trim().toLowerCase();

async function duration(file: string): Promise<number> {
  const { stderr } = await execFileAsync(getFfmpegPath(), ['-hide_banner', '-i', file], { maxBuffer: 8 * 1024 * 1024 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }));
  const m = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** Finds (or makes) the sound for a query and writes it into the clip folder. Null when nothing matches. */
export async function findSound(dir: string, query: string, libraryDir = soundLibraryDir()): Promise<SoundFile | null> {
  const key = soundKey(query);
  if (!key) return null;
  const match = libraryMatches(await listLibrary(libraryDir, AUDIO), query)[0];
  const builtin = match ? null : builtinFor(query);
  if (!match && !builtin) return null;
  const file = `sounds/sound_${createHash('sha1').update(`${key}|${match ?? builtin!.id}`).digest('hex').slice(0, 10)}.wav`;
  const out = path.join(dir, file);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const input = match ? ['-i', path.join(libraryDir, match)] : ['-f', 'lavfi', '-i', builtin!.recipe];
  await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', ...input, '-vn', '-t', String(MAX_SOUND_SEC), '-ar', '48000', '-ac', '2', out], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  const durationSec = await duration(out);
  if (durationSec <= 0) throw new Error('the sound came out empty');
  return {
    file,
    source: match ? 'library' : 'builtin',
    title: match ? path.basename(match).replace(AUDIO, '') : builtin!.id,
    origin: match ?? `built-in ${builtin!.id}`,
    durationSec: Number(durationSec.toFixed(2)),
    key,
  };
}

/**
 * Gives every item with a query its sound, keeping ones already found for the same query. An item
 * nothing matched keeps no sound (it plays silent) and the clip gets a warning.
 */
export async function prepareSounds<T extends { query?: string; sound?: SoundFile }>(dir: string, items: T[], libraryDir = soundLibraryDir()): Promise<{ items: T[]; warnings: string[] }> {
  const warnings: string[] = [];
  const out: T[] = [];
  for (const item of items) {
    const query = item.query?.trim();
    if (!query) {
      out.push(item);
      continue;
    }
    if (item.sound?.key === soundKey(query) && (await fs.stat(path.join(dir, item.sound.file)).then((s) => s.size > 0).catch(() => false))) {
      out.push(item);
      continue;
    }
    try {
      const sound = await findSound(dir, query, libraryDir);
      if (!sound) warnings.push(`No sound found for "${query}". Put a file named like it in storage/sounds (built in: ${BUILTIN_SOUNDS.map((s) => s.id).join(', ')}).`);
      out.push({ ...item, sound: sound ?? undefined });
    } catch (err) {
      warnings.push(`Sound "${query}" could not be used: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      out.push({ ...item, sound: undefined });
    }
  }
  return { items: out, warnings };
}

/**
 * The sounds a reaction edit needs: each "sound" hit's, and the ending's. An ending whose sound
 * isn't in the library gets its style's built-in one (a riser, a ding, a boom) instead of silence.
 */
export async function prepareReactionSounds(dir: string, plan: ClipPlan, libraryDir = soundLibraryDir()): Promise<{ plan: ClipPlan; warnings: string[] }> {
  const warnings: string[] = [];
  let effects = plan.effects;
  if (effects?.some((e) => e.kind === 'sound')) {
    const found = await prepareSounds(dir, effects.filter((e) => e.kind === 'sound'), libraryDir);
    warnings.push(...found.warnings);
    let k = 0;
    effects = effects.map((e) => (e.kind === 'sound' ? found.items[k++] : e));
  }
  for (const e of effects ?? []) {
    if (e.kind !== 'emoji' || !e.emoji || isEmojiChar(e.emoji.replace(/\s+/g, ''))) continue;
    if (!(await findEmojiImage(e.emoji))) warnings.push(`No emoji picture named like "${e.emoji}" in storage/emojis, so that pop-up was left out.`);
  }
  let ending = plan.ending;
  if (ending && ending.style !== 'none') {
    const query = ending.query?.trim() || ENDING_DEFAULTS[ending.style].query;
    // A library sound is kept; a built-in stand-in is looked up again (the file may be in the library by now)
    const kept = ending.sound?.source === 'library' && ending.sound.key === soundKey(query) && (await fs.stat(path.join(dir, ending.sound.file)).then((s) => s.size > 0).catch(() => false));
    if (!kept) {
      const sound = (await findSound(dir, query, libraryDir).catch(() => null)) ?? (await findSound(dir, ENDING_DEFAULTS[ending.style].fallback, libraryDir).catch(() => null));
      ending = { ...ending, sound: sound ? { ...sound, key: soundKey(query) } : undefined };
    }
  }
  return { plan: { ...plan, effects, ending }, warnings };
}
