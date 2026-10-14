import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { downloadToFile } from '../utils/download';

/**
 * The music library, organised by mood. Your own tracks go in storage/music/<mood>/ and are
 * always preferred; a starter pack of Kevin MacLeod tracks (incompetech.com, CC BY 4.0, free for
 * monetised videos with a credit line) fills any mood you haven't stocked, downloaded the first
 * time a video needs it. A track of yours can carry its own credit in "<file>.credit.txt".
 */

export const MOODS = ['tense', 'somber', 'mysterious', 'ominous', 'hopeful', 'triumphant', 'curious', 'calm'] as const;
export type Mood = (typeof MOODS)[number];

export const MOOD_DESCRIPTIONS: Record<Mood, string> = {
  tense: 'urgency, danger, a crisis unfolding',
  somber: 'loss, grief, reflection on damage done',
  mysterious: 'questions, investigation, the unknown',
  ominous: 'dread, something bad approaching',
  hopeful: 'recovery, progress, a way forward',
  triumphant: 'achievement, victory, a turning point won',
  curious: 'light explanation, how things work, playful facts',
  calm: 'quiet context, setting the scene, a pause',
};

/** Starter tracks per mood (Kevin MacLeod, incompetech.com). */
export const STARTER_PACK: Record<Mood, string[]> = {
  tense: ['Darkest Child', 'Nerves', 'Hidden Agenda'],
  somber: ['Sad Trio', 'At Rest', 'Bittersweet'],
  mysterious: ['Investigations', 'Lightless Dawn', 'Hiding Your Reality'],
  ominous: ['The Descent', 'Dark Walk', 'Long Note One'],
  hopeful: ['Inspired', 'Dreams Become Real', 'Lasting Hope'],
  triumphant: ['Heroic Age', 'Rising Game', 'Prelude and Action'],
  curious: ['Thinking Music', 'Carefree', 'Pamgaea'],
  calm: ['Clean Soul', 'Echoes of Time', 'Meditation Impromptu 01'],
};

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']);
const MAX_TRACK_BYTES = 60 * 1024 * 1024;

export interface MusicTrack {
  path: string;
  title: string;
  /** Credit line(s) for the video description, when the licence requires one. */
  credit: string | null;
  source: 'yours' | 'starter';
}

export const musicRoot = () => path.join(process.cwd(), 'storage', 'music');
const starterDir = (mood: Mood) => path.join(musicRoot(), '_starter', mood);

export function starterCredit(title: string): string {
  return `"${title}" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0 License\nhttp://creativecommons.org/licenses/by/4.0/`;
}

export const starterUrl = (title: string) =>
  `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(title)}.mp3`;

/** Your tracks for a mood, with any credit files beside them. */
export async function yourTracks(mood: Mood): Promise<MusicTrack[]> {
  const dir = path.join(musicRoot(), mood);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const tracks: MusicTrack[] = [];
  for (const file of files.sort()) {
    if (!AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const full = path.join(dir, file);
    const credit = await fs.readFile(`${full}.credit.txt`, 'utf-8').then((s) => s.trim() || null).catch(() => null);
    tracks.push({ path: full, title: path.basename(file, path.extname(file)), credit, source: 'yours' });
  }
  return tracks;
}

/** A starter track on disk, downloading it the first time. Null if it can't be fetched. */
export async function ensureStarterTrack(mood: Mood, title: string): Promise<MusicTrack | null> {
  const target = path.join(starterDir(mood), `${title}.mp3`);
  const present = await fs.stat(target).then((s) => s.size > 0).catch(() => false);
  if (!present) {
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await downloadToFile(starterUrl(title), target, { maxBytes: MAX_TRACK_BYTES, signal: AbortSignal.timeout(180_000) });
    } catch (err) {
      console.warn(`[Music] Could not download "${title}": ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
  return { path: target, title, credit: starterCredit(title), source: 'starter' };
}

/**
 * Tracks available for a mood: yours first, then starter tracks. Starter tracks are only
 * downloaded when `includeStarter` asks for them (so listing yours is instant).
 */
export async function tracksForMood(mood: Mood, includeStarter = true): Promise<MusicTrack[]> {
  const mine = await yourTracks(mood);
  if (!includeStarter) return mine;
  const starter: MusicTrack[] = [];
  for (const title of STARTER_PACK[mood]) {
    const track = await ensureStarterTrack(mood, title);
    if (track) starter.push(track);
  }
  return [...mine, ...starter];
}
