import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Writable } from 'node:stream';
import yazl from 'yazl';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getFfmpegPath } from '../utils/ffmpeg';
import { probeClipDurationSec } from '../assembly/assemble-beat';
import { readTimeline, type VideoTimeline } from '../utils/timeline';
import { rendersDir } from './publish-assets';
import { subtitlesForVideo } from './subtitle-files';

const execFileAsync = promisify(execFile);

/**
 * The edit, exported for DaVinci Resolve (free) to fine-tune by hand: an FCPXML timeline
 * (Resolve's File > Import > Timeline) with every beat's picture, its narration, the music and the
 * effects on their own tracks, at the exact positions of the finished video, plus the captions
 * as an SRT. Transitions overlap as in the video (alternating video tracks) for Resolve to blend.
 */

const FPS = 30;
/** A length in frames: never zero. */
const frames = (sec: number) => Math.max(1, Math.round(sec * FPS));
/** A position in frames: the start is frame 0. */
const at = (sec: number) => Math.max(0, Math.round(sec * FPS));
const t = (f: number) => (f === 0 ? '0s' : `${f}/${FPS}s`);
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ResolveMedia {
  /** Picture-only scene clips, with where each starts in the video. */
  scenes: Array<{ path: string; startSec: number; durationSec: number; beat: number }>;
  voices: Array<{ path: string; startSec: number; durationSec: number; beat: number }>;
  music?: { path: string; durationSec: number } | null;
  sfx?: { path: string; durationSec: number } | null;
  totalSec: number;
}

/**
 * The FCPXML (1.9) for the edit. All clips hang off one gap the length of the video, each at its
 * own offset: video on lanes 1 and 2 (alternating, so overlapping transitions both fit), each
 * beat's narration on lane -1, music on -2, effects on -3.
 */
export function buildFcpxml(title: string, media: ResolveMedia): string {
  const assets: string[] = [];
  const clips: string[] = [];
  let n = 0;
  const asset = (file: string, durationSec: number, video: boolean) => {
    const id = `a${++n}`;
    const name = path.basename(file, path.extname(file));
    assets.push(
      `    <asset id="${id}" name="${xml(name)}" start="0s" duration="${t(frames(durationSec))}" ${
        video ? 'hasVideo="1" hasAudio="0" format="r1"' : 'hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"'
      }>\n      <media-rep kind="original-media" src="${xml(pathToFileURL(file).href)}"/>\n    </asset>`,
    );
    return { id, name };
  };
  const clip = (ref: { id: string; name: string }, lane: number, startSec: number, durationSec: number, role?: string) =>
    clips.push(
      `          <asset-clip ref="${ref.id}" lane="${lane}" offset="${t(at(startSec))}" name="${xml(ref.name)}" start="0s" duration="${t(frames(durationSec))}"${role ? ` audioRole="${role}"` : ''}/>`,
    );

  media.scenes.forEach((s, i) => clip(asset(s.path, s.durationSec, true), i % 2 === 0 ? 1 : 2, s.startSec, s.durationSec));
  media.voices.forEach((v) => clip(asset(v.path, v.durationSec, false), -1, v.startSec, v.durationSec, 'dialogue'));
  if (media.music) clip(asset(media.music.path, media.music.durationSec, false), -2, 0, Math.min(media.music.durationSec, media.totalSec), 'music');
  if (media.sfx) clip(asset(media.sfx.path, media.sfx.durationSec, false), -3, 0, Math.min(media.sfx.durationSec, media.totalSec), 'effects');

  const total = t(frames(media.totalSec));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="FFVideoFormat1080p30" frameDuration="1/${FPS}s" width="1920" height="1080"/>
${assets.join('\n')}
  </resources>
  <library>
    <event name="${xml(title)}">
      <project name="${xml(title)}">
        <sequence format="r1" duration="${total}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <gap name="Edit" offset="0s" start="0s" duration="${total}">
${clips.join('\n')}
            </gap>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

export function resolveExportDir(videoId: string): string {
  return path.join(rendersDir(videoId), 'resolve');
}

const exists = (p: string | null | undefined) => (p ? fs.stat(p).then((s) => s.size > 0).catch(() => false) : Promise.resolve(false));

/**
 * Prepares the export folder: picture-only copies of the scenes (the narration has its own
 * track), the narration files, the stems, the captions and the timeline. Returns the folder.
 */
export async function prepareResolveExport(
  supabase: SupabaseClient,
  video: { id: string; title?: string | null; topic?: string | null; script_json?: Record<string, unknown> | null },
): Promise<string> {
  const timeline: VideoTimeline | null = readTimeline(video.script_json);
  if (!timeline) throw new Error('Render the video first: the export is built from the finished edit');
  const dir = resolveExportDir(video.id);
  await fs.rm(dir, { recursive: true, force: true });
  const mediaDir = path.join(dir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });

  const media: ResolveMedia = { scenes: [], voices: [], totalSec: timeline.totalMs / 1000 };
  for (const b of timeline.beats) {
    const tag = String(b.index + 1).padStart(3, '0');
    if (await exists(b.sceneClipPath)) {
      const out = path.join(mediaDir, `scene_${tag}.mp4`);
      await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-i', b.sceneClipPath!, '-an', '-c:v', 'copy', out]);
      media.scenes.push({ path: out, startSec: b.sceneStartMs / 1000, durationSec: await probeClipDurationSec(out), beat: b.index });
    }
    if (await exists(b.audioPath)) {
      const out = path.join(mediaDir, `voice_${tag}${path.extname(b.audioPath!) || '.mp3'}`);
      await fs.copyFile(b.audioPath!, out);
      media.voices.push({ path: out, startSec: b.voiceStartMs / 1000, durationSec: (b.voiceMs ?? 0) / 1000 || (await probeClipDurationSec(out)), beat: b.index });
    }
  }
  if (media.scenes.length === 0) throw new Error('The scene clips from the last render are gone; assemble the video again, then export');
  for (const kind of ['music', 'sfx'] as const) {
    const stem = timeline.stems?.[kind];
    if (await exists(stem)) {
      const out = path.join(mediaDir, `${kind}.m4a`);
      await fs.copyFile(stem!, out);
      media[kind] = { path: out, durationSec: await probeClipDurationSec(out) };
    }
  }

  const title = video.title || video.topic || 'Video';
  await fs.writeFile(path.join(dir, 'timeline.fcpxml'), buildFcpxml(title, media), 'utf-8');
  const subtitles = await subtitlesForVideo(supabase, video).catch(() => null);
  if (subtitles?.srt.trim()) await fs.writeFile(path.join(dir, 'captions.srt'), subtitles.srt, 'utf-8');
  await fs.writeFile(
    path.join(dir, 'README.txt'),
    [
      `"${title}" for DaVinci Resolve`,
      '',
      '1. In Resolve: File > Import > Timeline..., choose timeline.fcpxml.',
      '   (If you moved this folder, Resolve asks you to relink: point it at the media folder.)',
      '2. Captions: File > Import > Subtitle..., choose captions.srt, then drag it onto the timeline.',
      '',
      'Tracks: V1/V2 the picture (alternating, so transitions overlap), A1 narration (one clip per beat),',
      'A2 music, A3 sound effects. The effects and transitions are already in the picture; the music',
      'and effects are on their own tracks so you can change their levels.',
    ].join('\r\n'),
    'utf-8',
  );
  return dir;
}

/** The export folder as a zip. */
export async function writeResolveZip(dir: string, out: Writable): Promise<void> {
  const zip = new yazl.ZipFile();
  const walk = async (rel: string) => {
    for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(r);
      else zip.addFile(path.join(dir, r), r.split(path.sep).join('/'), { compress: !/\.(mp4|m4a|mp3|wav)$/i.test(entry.name) });
    }
  };
  await walk('');
  zip.end();
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.on('error', reject);
    out.on('finish', resolve);
    out.on('error', reject);
    zip.outputStream.pipe(out);
  });
}
