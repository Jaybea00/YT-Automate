import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/ffmpeg';
import type { ComposedShot } from '../visuals/shot-composer';
import { readSidecar } from '../visuals/shot-editor';
import { diagramRevealTimes } from '../visuals/motion/diagram';
import { ensureSoundLibrary, soundPath, type SoundId } from './sfx';

const execFileAsync = promisify(execFile);

/**
 * Smart sound design: effects placed by what is on screen, not one sound per beat. A big number
 * lands with an impact, chart bars and timeline events tick in, map pins ping, newspapers rustle,
 * kinetic words click, chapter cards ring in, and a section change swooshes through its dip.
 * Plain footage cuts stay clean. Times mirror the motion-graphic templates' own animation timing.
 */

export interface SoundCue {
  atMs: number;
  /** A library sound, or "real:<id>" for a recorded effect (with its `file`). */
  sound: SoundId | `real:${string}`;
  /** Relative level (1 = the designed level, already well under the voice). */
  gain: number;
  /** The recording to play, for real sounds; library sounds use their built file. */
  file?: string;
}

/** A looping ambience bed under a stretch of the video. */
export interface BedCue {
  startMs: number;
  endMs: number;
  file: string;
  /** Relative level, like a cue's. */
  gain: number;
  /** Fade in and out. */
  fadeMs: number;
}

export interface SceneForSound {
  /** Where the scene starts in the video. */
  sceneStartMs: number;
  /** Composed track (its shot list says what is on screen), or null for a single visual. */
  trackPath: string | null;
  /** The scene opens a new section (it dips in from black). */
  opensSection: boolean;
}

/**
 * Overall bed level: effects sit about 10 dB under the narration while they play (measured on
 * real beats), as documentary effects do, so they're felt more than noticed.
 */
const BED_GAIN = 0.2;
/** The same sound closer than this to its previous cue is dropped (no machine-gun ticks). */
const MIN_REPEAT_MS = 110;
const MAX_CUES = 400;
const MAX_KEY_CLICKS = 14;

const clampMin = (a: number, b: number) => Math.min(a, b);

/** Cues for one shot, in seconds from the shot's start. */
export function shotCues(
  shot: Pick<ComposedShot, 'renderedType' | 'durationSec' | 'note'> & { plan?: ComposedShot['plan'] },
): Array<{ at: number; sound: SoundId; gain: number }> {
  const d = shot.durationSec;
  // Beats composed before shot lists kept their plans still get sounds, from the shot type alone
  const plan: Partial<ComposedShot['plan']> = shot.plan ?? {};
  const cues: Array<{ at: number; sound: SoundId; gain: number }> = [];
  switch (shot.renderedType) {
    case 'title':
      // A riser builds into the card, which rings in as it appears
      cues.push({ at: -1.4, sound: 'riser', gain: 0.55 }, { at: 0.15, sound: 'chime', gain: 0.6 });
      break;
    case 'stat':
      // statTemplate counts up from 0.1 s over min(1.6, 45%) and lands
      cues.push({ at: 0, sound: 'whoosh', gain: 0.5 }, { at: 0.1 + clampMin(1.6, d * 0.45), sound: 'impact', gain: 0.9 });
      break;
    case 'chart': {
      const chart = plan.chart;
      const n = chart?.values.length ?? 0;
      if (chart?.chart_type === 'bar') {
        // Bars start 0.18 s apart and grow for min(1.4, 40%); each ticks as it lands
        const grow = clampMin(1.4, d * 0.4);
        for (let i = 0; i < n; i++) cues.push({ at: 0.25 + i * 0.18 + grow, sound: 'tick', gain: 0.55 });
      } else if (chart?.chart_type === 'line') {
        // The line draws from 0.3 s over min(2.2, 50%); each point ticks as the line reaches it
        const draw = clampMin(2.2, d * 0.5);
        for (let i = 0; i < n; i++) cues.push({ at: 0.3 + draw * (n === 1 ? 1 : i / (n - 1)), sound: 'tick', gain: 0.5 });
      } else {
        cues.push({ at: 0.2, sound: 'whoosh', gain: 0.5 });
      }
      break;
    }
    case 'timeline': {
      const n = Math.min(6, plan.timeline?.events.length ?? 0);
      const span = Math.max(0.6, d * 0.55);
      cues.push({ at: 0, sound: 'whoosh', gain: 0.35 });
      for (let i = 0; i < n; i++) cues.push({ at: 0.4 + (span * i) / n, sound: 'tick', gain: 0.55 });
      break;
    }
    case 'diagram': {
      // Each step appears when the narration reaches it (the same times the page uses)
      cues.push({ at: 0, sound: 'whoosh', gain: 0.35 });
      if (plan.diagram) {
        for (const at of diagramRevealTimes(plan.diagram, plan.covers ?? '', d)) cues.push({ at, sound: 'tick', gain: 0.55 });
      }
      break;
    }
    case 'comparison':
      cues.push({ at: 0.1, sound: 'whoosh', gain: 0.45 }, { at: clampMin(d * 0.35, 1.2), sound: 'whoosh', gain: 0.5 }, { at: clampMin(d * 0.35, 1.2) + 0.3, sound: 'tick', gain: 0.5 });
      break;
    case 'kinetic_text': {
      // Words appear across max(0.6, 45%) from 0.1 s
      const words = (plan.kinetic?.phrase ?? plan.covers ?? '').split(/\s+/).filter(Boolean).slice(0, MAX_KEY_CLICKS);
      const span = Math.max(0.6, d * 0.45);
      words.forEach((_, i) => cues.push({ at: 0.1 + (span * i) / words.length, sound: 'key', gain: 0.4 }));
      break;
    }
    case 'quote':
      cues.push({ at: 0, sound: 'whoosh', gain: 0.35 });
      break;
    case 'newspaper':
      cues.push({ at: 0, sound: 'paper', gain: 0.7 });
      break;
    case 'pitch': {
      // The ball sets off at 0.9 s and arrives at max(1.7 s, 80%); a goal lands with an impact
      const end = Math.max(1.7, d * 0.8);
      cues.push({ at: 0.9, sound: 'whoosh', gain: 0.45 });
      if (plan.pitch?.outcome === 'goal') cues.push({ at: end, sound: 'impact', gain: 0.85 });
      break;
    }
    case 'evidence_board': {
      // Each clue is pinned 0.18 s after the last, from 0.15 s
      const n = Math.min(6, plan.evidence?.items.length ?? 3);
      for (let i = 0; i < n; i++) cues.push({ at: 0.15 + i * 0.18, sound: 'paper', gain: 0.45 });
      break;
    }
    case 'letter':
      cues.push({ at: 0, sound: 'paper', gain: 0.6 });
      break;
    case 'race_bars': {
      // Times race: each bar finishes after a time proportional to its value
      const items = plan.race?.items ?? [];
      const max = Math.max(...items.map((i) => i.value), 1);
      const span = Math.max(0.8, d * 0.6);
      for (const it of items) cues.push({ at: 0.5 + (plan.race?.lower_is_better ? (span * it.value) / max : span), sound: 'tick', gain: 0.55 });
      break;
    }
    case 'spec_card': {
      const n = plan.spec?.rows.length ?? 3;
      for (let i = 0; i < n; i++) cues.push({ at: 0.5 + i * Math.min(0.35, (d * 0.5) / n), sound: 'tick', gain: 0.5 });
      break;
    }
    case 'money':
      cues.push({ at: 0.4, sound: 'whoosh', gain: 0.4 }, { at: 0.4 + Math.max(0.8, d * 0.6), sound: 'chime', gain: 0.5 });
      break;
    case 'scale': {
      const n = plan.scale?.items.length ?? 2;
      const step = Math.max(0.6, (d * 0.85 - 0.3) / n);
      for (let i = 0; i < n; i++) cues.push({ at: 0.3 + step * i, sound: 'whoosh', gain: 0.4 });
      break;
    }
    case 'geo_map': {
      // map-scene: the camera settles over min(2.4, 55%); pins drop as each arc arrives
      cues.push({ at: 0, sound: 'swoosh', gain: 0.5 });
      const places = plan.map?.places.length ?? 1;
      const camEnd = clampMin(2.4, d * 0.55);
      if (places <= 1 || plan.map?.mode === 'locate') {
        cues.push({ at: camEnd * 0.6, sound: 'ping', gain: 0.6 });
      } else {
        const arcs = places - 1;
        const span = Math.max(0.6, d * 0.82 - camEnd * 0.5);
        cues.push({ at: 0.3, sound: 'ping', gain: 0.5 });
        for (let i = 0; i < arcs; i++) cues.push({ at: camEnd * 0.5 + (span * i) / arcs + (span / arcs) * 0.8, sound: 'ping', gain: 0.6 });
      }
      break;
    }
    default:
      // Footage: only a name caption sliding in, or an annotation ring drawing on, gets a sound
      if (shot.note?.includes('caption:')) cues.push({ at: 0.35, sound: 'whoosh', gain: 0.4 });
      // annotated-photo.ts: the ring draws from pushStart + 75% of the push
      if (shot.note?.includes('annotated:')) cues.push({ at: Math.min(0.5, d * 0.1) + Math.min(1.8, d * 0.35) * 0.75, sound: 'whoosh', gain: 0.45 });
  }
  return cues.filter((c) => c.at <= d);
}

/** Every cue in the video, from composed beats' shot lists and section changes. */
export async function planSoundCues(scenes: SceneForSound[]): Promise<SoundCue[]> {
  const cues: SoundCue[] = [];
  for (const [pos, scene] of scenes.entries()) {
    // A section change swooshes through its dip to black
    if (scene.opensSection && pos > 0) cues.push({ atMs: scene.sceneStartMs - 300, sound: 'swoosh', gain: 0.6 });
    if (!scene.trackPath) continue;
    const sidecar = await readSidecar(scene.trackPath);
    for (const shot of sidecar?.shots ?? []) {
      for (const c of shotCues(shot)) {
        cues.push({ atMs: Math.round(scene.sceneStartMs + (shot.startSec + c.at) * 1000), sound: c.sound, gain: c.gain });
      }
    }
  }
  return thinCues(cues);
}

/** Drops cues before the start, too-close repeats of one sound, and anything past the cap. */
export function thinCues(cues: SoundCue[]): SoundCue[] {
  const lastAt = new Map<SoundCue['sound'], number>();
  return [...cues]
    .filter((c) => c.atMs >= 0)
    .sort((a, b) => a.atMs - b.atMs)
    .filter((c) => {
      const prev = lastAt.get(c.sound);
      if (prev !== undefined && c.atMs - prev < MIN_REPEAT_MS) return false;
      lastAt.set(c.sound, c.atMs);
      return true;
    })
    .slice(0, MAX_CUES);
}

/**
 * Lays the cues over the programme in one pass: each library sound is split once per use,
 * delayed into place and set to its level, then everything is summed with the programme
 * (without amix's input halving). The picture is copied.
 */
export async function applySoundDesign(options: {
  videoPath: string;
  outputPath: string;
  cues: SoundCue[];
  /** Ambience beds, looped under their stretch. */
  beds?: BedCue[];
  /** The video's effects volume setting, where 0.25 is the designed level. */
  volume?: number;
  /** Also writes the effects on their own here (for editing elsewhere, e.g. DaVinci Resolve). */
  stemPath?: string;
}): Promise<{ outputPath: string; cueCount: number }> {
  const { videoPath, outputPath, cues } = options;
  const beds = options.beds ?? [];
  const master = BED_GAIN * Math.max(0, Math.min(3, (options.volume ?? 0.25) / 0.25));
  if ((cues.length === 0 && beds.length === 0) || master === 0) {
    await fs.copyFile(videoPath, outputPath);
    return { outputPath, cueCount: 0 };
  }
  await ensureSoundLibrary();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const fileOf = (c: SoundCue) => c.file ?? soundPath(c.sound as SoundId);
  const sounds = [...new Set(cues.map(fileOf))];
  const inputs = sounds.flatMap((s) => ['-i', s]);
  const graph: string[] = [];
  const labels: string[] = [];
  sounds.forEach((sound, si) => {
    const uses = cues.filter((c) => fileOf(c) === sound);
    const outs = uses.map((_, ui) => `[s${si}u${ui}]`);
    graph.push(`[${si + 1}:a]asplit=${uses.length}${outs.join('')}`);
    uses.forEach((cue, ui) => {
      const label = `[c${si}_${ui}]`;
      graph.push(`[s${si}u${ui}]adelay=${cue.atMs}:all=1,volume=${(cue.gain * master).toFixed(3)},aformat=channel_layouts=stereo${label}`);
      labels.push(label);
    });
  });
  // Each bed is its own looping input, cut to its stretch, faded at both ends and delayed into place
  const bedInputs = beds.flatMap((b) => ['-stream_loop', '-1', '-i', b.file]);
  beds.forEach((bed, bi) => {
    const durSec = (bed.endMs - bed.startMs) / 1000;
    const fade = Math.min(bed.fadeMs / 1000, durSec / 3);
    const label = `[bed${bi}]`;
    graph.push(
      `[${sounds.length + 1 + bi}:a]atrim=0:${durSec.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=${fade.toFixed(2)},afade=t=out:st=${(durSec - fade).toFixed(3)}:d=${fade.toFixed(2)},adelay=${bed.startMs}:all=1,volume=${(bed.gain * master).toFixed(3)},aformat=channel_layouts=stereo${label}`,
    );
    labels.push(label);
  });
  if (options.stemPath) {
    // Effects summed over silence of the programme's length, then added to it: the same mix, plus an effects-only copy
    graph.push(`[0:a]asplit=2[prog][quiet]`, `[quiet]volume=0[silence]`);
    graph.push(`[silence]${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:dropout_transition=0:normalize=0,asplit=2[fx][fxstem]`);
    graph.push(`[prog][fx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
  } else {
    graph.push(`[0:a]${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
  }

  // Large graphs go through a script file (Windows caps command-line length)
  const scriptPath = `${outputPath}.sfx-graph.txt`;
  await fs.writeFile(scriptPath, graph.join(';\n'), 'utf-8');
  try {
    await execFileAsync(
      getFfmpegPath(),
      // "-/option file" reads the option's value from a file (ffmpeg 7+; -filter_complex_script is gone)
      ['-y', '-i', videoPath, ...inputs, ...bedInputs, '-/filter_complex', scriptPath, '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', outputPath, ...(options.stemPath ? ['-map', '[fxstem]', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', options.stemPath] : [])],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    await fs.unlink(scriptPath).catch(() => {});
  }
  return { outputPath, cueCount: cues.length + beds.length };
}
