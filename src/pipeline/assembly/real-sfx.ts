import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);

/**
 * Real recorded sound effects for moments the narration describes (a gunshot on "fires two
 * shots", a roar on a goal). Sounds come from the creator's own files in
 * storage/sfx/real/<sound>/ or, with a FREESOUND_API_KEY, are fetched once from Freesound,
 * CC0 only (no attribution needed; the source is still recorded beside the file).
 */

export interface RealSound {
  label: string;
  /** Freesound search used when the sound has to be fetched. */
  query: string;
  /** Longest it plays, in seconds (longer recordings are cut with a fade). */
  maxSec: number;
  /** Level relative to the effects bed; violent sounds are kept restrained. */
  gain: number;
  /**
   * What it's for: absent for one-shot moments the narration triggers; "palette" for a real
   * version of an on-screen effect (a style's whoosh or click); "bed" for looping ambience.
   */
  kind?: 'palette' | 'bed';
}

export const REAL_SOUNDS = {
  gunshot: { label: 'Gunshot', query: 'single gunshot pistol', maxSec: 2.5, gain: 1.6 },
  gunfire: { label: 'Gunfire burst', query: 'machine gun burst distant', maxSec: 3, gain: 1.3 },
  explosion: { label: 'Explosion', query: 'explosion distant boom', maxSec: 4, gain: 1.6 },
  cannon: { label: 'Cannon / artillery', query: 'cannon artillery fire distant', maxSec: 4, gain: 1.4 },
  sword_clash: { label: 'Sword clash', query: 'sword clash metal', maxSec: 2, gain: 1.4 },
  punch: { label: 'Punch', query: 'punch hit body', maxSec: 1.2, gain: 1.4 },
  glass_break: { label: 'Glass breaking', query: 'glass break shatter', maxSec: 2.5, gain: 1.4 },
  door_slam: { label: 'Door slam', query: 'door slam', maxSec: 1.8, gain: 1.4 },
  door_creak: { label: 'Door creak', query: 'door creak open', maxSec: 3, gain: 1.3 },
  footsteps: { label: 'Footsteps', query: 'footsteps walking hallway', maxSec: 4, gain: 1.2 },
  heartbeat: { label: 'Heartbeat', query: 'heartbeat slow', maxSec: 5, gain: 1.4 },
  clock_ticking: { label: 'Clock ticking', query: 'clock ticking', maxSec: 4, gain: 1.2 },
  bell_toll: { label: 'Bell toll', query: 'church bell toll single', maxSec: 5, gain: 1.3 },
  crowd_cheer: { label: 'Crowd cheer', query: 'stadium crowd cheer goal', maxSec: 5, gain: 1.5 },
  crowd_gasp: { label: 'Crowd gasp', query: 'crowd gasp shock', maxSec: 3, gain: 1.4 },
  applause: { label: 'Applause', query: 'applause audience', maxSec: 5, gain: 1.3 },
  whistle: { label: 'Referee whistle', query: 'referee whistle', maxSec: 2, gain: 1.4 },
  ball_kick: { label: 'Ball kick', query: 'football ball kick', maxSec: 1.2, gain: 1.5 },
  siren: { label: 'Siren', query: 'police siren passing', maxSec: 5, gain: 1.2 },
  thunder: { label: 'Thunder', query: 'thunder clap', maxSec: 5, gain: 1.4 },
  fire_crackle: { label: 'Fire crackling', query: 'fire crackling', maxSec: 5, gain: 1.2 },
  car_engine: { label: 'Car engine', query: 'car engine rev', maxSec: 4, gain: 1.3 },
  tyre_screech: { label: 'Tyre screech', query: 'tire screech car', maxSec: 3, gain: 1.3 },
  car_crash: { label: 'Car crash', query: 'car crash impact', maxSec: 3, gain: 1.3 },
  plane_flyover: { label: 'Plane flyover', query: 'airplane flyover', maxSec: 5, gain: 1.2 },
  train: { label: 'Train', query: 'steam train passing whistle', maxSec: 5, gain: 1.2 },
  ship_horn: { label: 'Ship horn', query: 'ship horn', maxSec: 4, gain: 1.2 },
  rocket_launch: { label: 'Rocket launch', query: 'rocket launch rumble', maxSec: 5, gain: 1.3 },
  camera_shutter: { label: 'Camera shutter', query: 'camera shutter click', maxSec: 1, gain: 1.3 },
  typewriter: { label: 'Typewriter', query: 'typewriter typing', maxSec: 3, gain: 1.2 },
  telegraph: { label: 'Telegraph / morse', query: 'telegraph morse code', maxSec: 3, gain: 1.2 },
  cash_register: { label: 'Cash register', query: 'cash register ka-ching', maxSec: 2, gain: 1.3 },
  coins: { label: 'Coins', query: 'coins drop pile', maxSec: 2, gain: 1.2 },
  phone_ring: { label: 'Phone ringing', query: 'old telephone ring', maxSec: 3, gain: 1.2 },
  radio_static: { label: 'Radio static', query: 'radio static tuning', maxSec: 3, gain: 1.1 },
  horse_gallop: { label: 'Horses galloping', query: 'horse gallop', maxSec: 4, gain: 1.2 },
  splash: { label: 'Splash', query: 'water splash', maxSec: 2, gain: 1.3 },

  // Real versions of the on-screen effects, chosen per style (see palettes.ts)
  whoosh_soft: { label: 'Soft whoosh', query: 'whoosh swish short', maxSec: 1.2, gain: 1, kind: 'palette' },
  whoosh_dark: { label: 'Dark whoosh', query: 'dark cinematic whoosh', maxSec: 1.6, gain: 1, kind: 'palette' },
  cinematic_boom: { label: 'Cinematic boom', query: 'cinematic boom hit impact', maxSec: 3, gain: 1, kind: 'palette' },
  tension_riser: { label: 'Tension riser', query: 'cinematic riser tension', maxSec: 2, gain: 1, kind: 'palette' },
  ui_click: { label: 'UI click', query: 'ui click interface button', maxSec: 0.4, gain: 1, kind: 'palette' },
  ui_ping: { label: 'UI ping', query: 'notification ping soft', maxSec: 1, gain: 1, kind: 'palette' },
  keyboard_key: { label: 'Keyboard key', query: 'keyboard single key press', maxSec: 0.3, gain: 1, kind: 'palette' },
  typewriter_key: { label: 'Typewriter key', query: 'typewriter single key strike', maxSec: 0.4, gain: 1, kind: 'palette' },
  paper_rustle: { label: 'Paper rustle', query: 'newspaper paper rustle', maxSec: 1.5, gain: 1, kind: 'palette' },
  page_turn: { label: 'Page turn', query: 'book page turn', maxSec: 1.2, gain: 1, kind: 'palette' },
  bell_ding: { label: 'Bell ding', query: 'small bell ding single', maxSec: 2, gain: 1, kind: 'palette' },
  stamp: { label: 'Rubber stamp', query: 'rubber stamp hit paper', maxSec: 0.8, gain: 1, kind: 'palette' },
  music_sting: { label: 'Music sting', query: 'cinematic sting hit orchestral', maxSec: 3, gain: 1, kind: 'palette' },

  // Ambience beds, looped quietly under a stretch of beats
  stadium_bed: { label: 'Stadium crowd ambience', query: 'stadium crowd ambience', maxSec: 40, gain: 0.5, kind: 'bed' },
  battle_bed: { label: 'Distant battle ambience', query: 'distant battle artillery ambience', maxSec: 40, gain: 0.45, kind: 'bed' },
  rain_bed: { label: 'Rain', query: 'rain ambience', maxSec: 40, gain: 0.5, kind: 'bed' },
  wind_bed: { label: 'Wind', query: 'wind ambience', maxSec: 40, gain: 0.45, kind: 'bed' },
  city_bed: { label: 'City street', query: 'city street ambience traffic', maxSec: 40, gain: 0.45, kind: 'bed' },
  night_bed: { label: 'Night, crickets', query: 'night crickets ambience', maxSec: 40, gain: 0.45, kind: 'bed' },
  crowd_bed: { label: 'Indoor crowd murmur', query: 'crowd murmur indoor ambience', maxSec: 40, gain: 0.45, kind: 'bed' },
  ocean_bed: { label: 'Ocean waves', query: 'ocean waves ambience', maxSec: 40, gain: 0.45, kind: 'bed' },
  forest_bed: { label: 'Forest, birds', query: 'forest birds ambience', maxSec: 40, gain: 0.45, kind: 'bed' },
  office_bed: { label: 'Office room tone', query: 'office ambience room tone', maxSec: 40, gain: 0.4, kind: 'bed' },
  fire_bed: { label: 'Fire crackling (bed)', query: 'fireplace crackling ambience', maxSec: 40, gain: 0.45, kind: 'bed' },
  space_bed: { label: 'Space drone', query: 'space ambience drone', maxSec: 40, gain: 0.4, kind: 'bed' },
  dread_bed: { label: 'Dark drone', query: 'dark ambient drone tension', maxSec: 40, gain: 0.4, kind: 'bed' },
} satisfies Record<string, RealSound>;

export type RealSoundId = keyof typeof REAL_SOUNDS;
export const REAL_SOUND_IDS = Object.keys(REAL_SOUNDS) as RealSoundId[];
export const isRealSoundId = (v: unknown): v is RealSoundId => typeof v === 'string' && v in REAL_SOUNDS;
const kindOf = (id: RealSoundId): RealSound['kind'] => (REAL_SOUNDS[id] as RealSound).kind;
/** Sounds the narration can trigger. */
export const MOMENT_SOUND_IDS = REAL_SOUND_IDS.filter((id) => kindOf(id) === undefined);
/** Ambience beds. */
export const BED_SOUND_IDS = REAL_SOUND_IDS.filter((id) => kindOf(id) === 'bed');

const AUDIO_FILE = /\.(mp3|wav|ogg|flac|m4a)$/i;
const PEAK_DB = -3;

export const realSoundsDir = () => path.join(process.cwd(), 'storage', 'sfx', 'real');
const preparedPath = (id: RealSoundId) => path.join(realSoundsDir(), '_prepared', `${id}.wav`);

/** The creator's (or a previously fetched) recording for a sound, newest first. */
export async function findSourceFile(id: RealSoundId, dir = realSoundsDir()): Promise<string | null> {
  const folder = path.join(dir, id);
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((n) => AUDIO_FILE.test(n))
      .map(async (n) => ({ file: path.join(folder, n), mtime: (await fs.stat(path.join(folder, n))).mtimeMs })),
  );
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0]?.file ?? null;
}

interface FreesoundResult {
  id: number;
  name: string;
  username: string;
  license: string;
  duration: number;
  previews?: Record<string, string>;
  tags?: string[];
}

/** Freesound search: CC0 only, short, best rated first. */
export function freesoundSearchUrl(sound: RealSound, apiKey: string): string {
  const params = new URLSearchParams({
    query: sound.query,
    filter: `license:"Creative Commons 0" duration:[0.2 TO ${Math.max(3, sound.maxSec * 3)}]`,
    sort: 'rating_desc',
    fields: 'id,name,username,license,duration,previews,tags',
    page_size: '10',
    token: apiKey,
  });
  return `https://freesound.org/apiv2/search/text/?${params.toString()}`;
}

/** Downloads the best CC0 match into the sound's folder, with a note of where it came from. */
export async function fetchFromFreesound(id: RealSoundId, apiKey: string, dir = realSoundsDir()): Promise<string | null> {
  // Freesound needs every word to match, so a phrase that finds nothing is tried shorter
  let pick: FreesoundResult | undefined;
  for (const query of broaderQueries(REAL_SOUNDS[id].query)) {
    const res = await fetchPolitely(freesoundSearchUrl({ ...REAL_SOUNDS[id], query }, apiKey));
    if (!res.ok) throw new Error(`Freesound search failed (${res.status})`);
    const body = (await res.json()) as { results?: FreesoundResult[] };
    const usable = (body.results ?? []).filter((r) => /creativecommons\.org\/publicdomain\/zero|Creative Commons 0/i.test(r.license) && r.previews?.['preview-hq-mp3']);
    pick = bestMatches(usable, REAL_SOUNDS[id].query)[0];
    if (pick) break;
  }
  if (!pick) return null;
  const audio = await fetch(pick.previews!['preview-hq-mp3']);
  if (!audio.ok) throw new Error(`Freesound download failed (${audio.status})`);
  const folder = path.join(dir, id);
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, `freesound-${pick.id}.mp3`);
  await fs.writeFile(file, Buffer.from(await audio.arrayBuffer()));
  await fs.writeFile(
    `${file}.json`,
    JSON.stringify({ source: 'freesound', id: pick.id, name: pick.name, author: pick.username, license: pick.license, url: `https://freesound.org/s/${pick.id}/` }, null, 2),
  );
  return file;
}

/**
 * A sound ready to mix: the recording cut to its maximum length with a short fade, mono 48 kHz,
 * peak-normalised so its level is set only at the mix. Rebuilt when the source changes. Fetched
 * from Freesound when missing and a key is set. Null when the sound isn't available.
 */
export async function prepareRealSound(id: RealSoundId, apiKey = process.env.FREESOUND_API_KEY): Promise<string | null> {
  let source = await findSourceFile(id);
  if (!source && apiKey) {
    source = await fetchFromFreesound(id, apiKey).catch((err) => {
      console.warn(`[SFX] Could not fetch "${id}" from Freesound: ${err instanceof Error ? err.message : err}`);
      return null;
    });
  }
  if (!source) return null;

  const target = preparedPath(id);
  const [src, out] = await Promise.all([fs.stat(source), fs.stat(target).catch(() => null)]);
  if (out && out.size > 0 && out.mtimeMs >= src.mtimeMs) return target;

  const { maxSec } = REAL_SOUNDS[id];
  const bed = kindOf(id) === 'bed';
  // Beds loop, so both ends fade to keep the seam soft
  const fadeLen = bed ? 1 : 0.4;
  const fadeAt = Math.max(0, maxSec - fadeLen);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const raw = `${target}.raw.wav`;
  try {
    await execFileAsync(getFfmpegPath(), [
      '-y', '-v', 'error', '-i', source,
      // Trim leading silence so the sound hits on its word
      '-af', `silenceremove=start_periods=1:start_threshold=-45dB,atrim=0:${maxSec},afade=t=out:st=${fadeAt}:d=${fadeLen}${bed ? ',afade=t=in:d=1' : ''}`,
      '-ac', '1', '-ar', '48000', raw,
    ]);
    const { stderr } = await execFileAsync(getFfmpegPath(), ['-hide_banner', '-i', raw, '-af', 'volumedetect', '-f', 'null', '-']);
    const peak = Number.parseFloat(stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1] ?? '0');
    await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-i', raw, '-af', `volume=${(PEAK_DB - peak).toFixed(2)}dB`, target]);
    return target;
  } catch (err) {
    console.warn(`[SFX] Could not prepare "${id}" from ${path.basename(source)}:`, err instanceof Error ? err.message.slice(0, 200) : err);
    return null;
  } finally {
    await fs.unlink(raw).catch(() => {});
  }
}

/** A search phrase and its shorter forms, most specific first ("stadium crowd cheer goal" ... "stadium crowd"). */
export function broaderQueries(query: string): string[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let n = words.length; n >= Math.min(2, words.length); n--) out.push(words.slice(0, n).join(' '));
  return out;
}

/** Words that say little about what a sound is. */
const GENERIC_WORDS = new Set(['single', 'distant', 'sound', 'effect', 'ambience', 'ambient', 'heavy', 'short', 'long', 'loud', 'soft', 'close', 'small', 'large', 'fast', 'slow', 'deep', 'dark']);

/**
 * Whether a result is the sound asked for: its name or tags contain one of the phrase's telling
 * words (so "typewriter single key" doesn't settle for a computer keyboard).
 */
export function isAbout(result: { name: string; tags?: string[] }, query: string): boolean {
  const words = tellingWords(query);
  if (!words.length) return true;
  // Any telling word in the name, or the first in the tags ("referee whistle" -> a sound named "whistle")
  const name = result.name.toLowerCase();
  return words.some((w) => name.includes(w)) || (result.tags ?? []).join(' ').toLowerCase().includes(words[0]);
}

/** The phrase's telling words, cut to stems ("stadium crowd ambience" -> ["stadi", "crowd"]). */
export function tellingWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w))
    .map((w) => w.slice(0, 5));
}

/** Results that are about the sound, those that name it first (a name says more than a tag). */
export function bestMatches<T extends { name: string; tags?: string[] }>(results: T[], query: string): T[] {
  const words = tellingWords(query);
  const about = results.filter((r) => isAbout(r, query));
  const named = (r: T) => words.some((w) => r.name.toLowerCase().includes(w));
  return [...about.filter(named), ...about.filter((r) => !named(r))];
}

/**
 * A Freesound request that waits and tries again when told to slow down (they allow 60 a minute),
 * rather than giving up on the sound.
 */
export async function fetchPolitely(url: string, tries = 3, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.status !== 429 || attempt >= tries) return res;
    const after = Number(res.headers.get('retry-after'));
    await wait(Number.isFinite(after) && after > 0 ? Math.min(60, after) * 1000 : 15_000 * attempt);
  }
}
