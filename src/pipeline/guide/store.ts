import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../utils/atomic-write';
import { getFfmpegPath, getFfprobePath } from '../utils/ffmpeg';
import type { FootageInfo, GuideProject } from './types';

const execFileAsync = promisify(execFile);

/**
 * One folder per guide under storage/guides/<id>: guide.json, the recordings under footage/, the
 * voice under voice/, and the finished Short under export/.
 */

export const guidesRoot = () => process.env.GUIDES_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'guides');
/** A logo shared by every guide (shown over the title when a guide names none). */
export const sharedLogo = () => path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'guide', 'logo.png');

const ID_PATTERN = /^[a-z0-9-]{3,60}$/;
export const isGuideId = (id: string) => ID_PATTERN.test(id);

export function guideDir(id: string): string {
  if (!isGuideId(id)) throw new Error(`Invalid guide id "${id}": use lowercase letters, numbers and dashes`);
  return path.join(guidesRoot(), id);
}

/** A file inside a guide's folder; refuses names that would step outside it. */
export function guideFile(dir: string, name: string): string {
  // Both sides resolved, so "C:/x" and "C:\x" (and short 8.3 names written either way) compare alike
  const base = path.resolve(dir);
  const full = path.resolve(base, name);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`"${name}" is outside the guide's folder`);
  return full;
}

/** A new guide's starting point: the shape of a "5 things" Short, with the parts to fill in. */
export function guideTemplate(id: string, now = new Date().toISOString()): GuideProject {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    title: '5 CRAZY Things You Can Do In GTA 6 #gta6 #gta #gtavi',
    titleCard: '5 *CRAZY* THINGS YOU CAN DO',
    hook: "Here's five *crazy* things you can do in GTA 6 that you could ~never~ do in GTA 5.",
    opener: { file: 'footage/opener.mp4', from: 4, to: 7.5 },
    items: [1, 2, 3, 4, 5].map((n) => ({
      heading: `Thing number ${n}`,
      emoji: '🔥',
      say: `Number ${n}, …`,
      shots: [{ file: `footage/${n}.mp4`, from: 0, to: 20 }],
    })),
    outro: 'So which one are you going to try *first*?',
    loopLine: 'And in case you missed it,',
    numbered: true,
    voice: '',
    speed: 1.15,
    cutSec: 1.5,
    gameVolume: 0.18,
    whooshes: true,
    grade: false,
    description: '',
    tags: ['gta6', 'gta', 'gtavi'],
  };
}

export async function loadGuide(id: string): Promise<GuideProject | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(guideDir(id), 'guide.json'), 'utf-8')) as GuideProject;
  } catch {
    return null;
  }
}

export async function saveGuide(project: GuideProject): Promise<GuideProject> {
  const dir = guideDir(project.id);
  await fs.mkdir(dir, { recursive: true });
  const next = { ...project, updatedAt: new Date().toISOString() };
  await writeFileAtomic(path.join(dir, 'guide.json'), JSON.stringify(next, null, 2));
  return next;
}

/** A new guide folder with its template and an empty footage/ folder (refuses one that exists). */
export async function createGuide(id: string): Promise<GuideProject> {
  if (await loadGuide(id)) throw new Error(`Guide "${id}" already exists`);
  await fs.mkdir(path.join(guideDir(id), 'footage'), { recursive: true });
  return saveGuide(guideTemplate(id));
}

/** A recording's size, length and whether it has sound. */
export async function probeFootage(file: string): Promise<FootageInfo> {
  const { stdout } = await execFileAsync(getFfprobePath(), ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:stream_side_data=rotation:format=duration', '-of', 'json', file]);
  const info = JSON.parse(stdout) as { streams?: Array<{ codec_type: string; width?: number; height?: number; side_data_list?: Array<{ rotation?: number }> }>; format?: { duration?: string } };
  const video = info.streams?.find((s) => s.codec_type === 'video');
  if (!video?.width || !video.height) throw new Error(`${path.basename(file)} has no picture`);
  // A phone recording turned on its side reports its size before the turn
  const turned = Math.abs(video.side_data_list?.find((d) => d.rotation != null)?.rotation ?? 0) === 90;
  const width = turned ? video.height : video.width;
  const height = turned ? video.width : video.height;
  const durationSec = Number(info.format?.duration ?? 0);
  const box = await blackBars(file, durationSec, width, height).catch(() => null);
  return { width, height, durationSec, hasAudio: !!info.streams?.some((s) => s.codec_type === 'audio'), ...(box ? { box } : {}) };
}

/** The most common crop ffmpeg's cropdetect reports, as "crop=w:h:x:y" lines. */
export function commonCrop(log: string): { w: number; h: number; x: number; y: number } | null {
  const counts = new Map<string, number>();
  for (const m of log.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const [w, h, x, y] = top[0].slice(5).split(':').map(Number);
  return { w, h, x, y };
}

/**
 * Black bars a recording was posted with (a 2:1 picture letterboxed into 16:9), found by sampling
 * the middle of it. Null when there are none, or when "bars" would eat most of the picture (a dark
 * scene, not bars).
 */
async function blackBars(file: string, durationSec: number, width: number, height: number): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const from = Math.max(0, durationSec / 2 - 5);
  const { stderr } = await execFileAsync(getFfmpegPath(), ['-hide_banner', '-ss', from.toFixed(2), '-t', '10', '-i', file, '-vf', 'fps=2,cropdetect=24:2:0', '-an', '-f', 'null', '-'], { maxBuffer: 8 * 1024 * 1024 });
  const c = commonCrop(stderr);
  if (!c || (c.w >= width - 8 && c.h >= height - 8)) return null;
  if (c.w * c.h < width * height * 0.6) return null;
  return c;
}
