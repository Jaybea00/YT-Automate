import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { chromium } from 'playwright';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '../providers/registry';
import type { LLMProvider } from '../providers/types';
import { motionDocument, FRAME_HEIGHT, FRAME_WIDTH, FPS } from '../visuals/motion/frame-renderer';
import { escapeHtml } from '../visuals/motion/templates';
import type { MotionTheme } from '../visuals/motion/theme';
import { narrationHash } from './sound-moments';
import { stylePack } from '@/lib/styles/packs';

/**
 * Emphasis effects, applied once at mastering (before the captions, so captions never shake or
 * freeze): a camera shake on impact sounds, a freeze-frame with a title on big moments, a zoom
 * punch into chapter changes in fast styles, and letterbox bars in cinematic ones.
 */

export interface FreezeMoment {
  beat_index: number;
  /** 1-5 words on screen: a date, a name, a number, a place. */
  title: string;
}

export interface EmphasisPlan {
  textHash: string;
  plannedAt: string;
  freezes: FreezeMoment[];
}

export interface EmphasisWindows {
  shakes: Array<{ atSec: number }>;
  freezes: Array<{ atSec: number; durSec: number; titlePng: string }>;
  zooms: Array<{ atSec: number }>;
  /** Height of each letterbox bar, in px (0 for none). */
  letterboxPx: number;
}

export const SHAKE_SEC = 0.5;
const SHAKE_PX = 14;
export const ZOOM_SEC = 0.6;
const ZOOM_FROM = 1.14;
export const MAX_FREEZE_SEC = 2.5;
const MIN_FREEZE_SEC = 1.2;
/** Bars for a 2:1 picture: thin enough to keep graphics and captions clear. */
export const LETTERBOX_PX = Math.round((FRAME_HEIGHT - FRAME_WIDTH / 2) / 2);
/** Impact sounds get a shake; others (a whistle, a typewriter) don't. */
export const IMPACT_SOUNDS = new Set(['gunshot', 'gunfire', 'explosion', 'cannon', 'punch', 'car_crash', 'door_slam', 'glass_break', 'thunder', 'sword_clash']);

const Schema = z.object({ freezes: z.array(z.object({ beat_index: z.number(), title: z.string() })) });
type Beat = { index: number; text: string };

export const maxFreezes = (beats: Beat[]) => Math.max(1, Math.min(3, Math.round(beats.length / 20)));

export function buildEmphasisPrompt(beats: Beat[]): string {
  return `Choose freeze-frame moments for a documentary: the picture freezes for two seconds with a short title on screen, the way documentaries introduce a key person or mark the instant everything changed.
Pick at most ${maxFreezes(beats)}, only real turning points or the first appearance of a central person. For each: beat_index, and title: 1-5 words that name the moment (a date, a name, a place, a number), e.g. "28 JUNE 1914", "GAVRILO PRINCIP, 19". Only facts stated in that beat.

NARRATION (beat index, text):
${beats.map((b) => `[${b.index}] ${b.text}`).join('\n')}`;
}

export function normalizeFreezes(raw: z.infer<typeof Schema>['freezes'], beats: Beat[]): FreezeMoment[] {
  const valid = new Set(beats.map((b) => b.index));
  const seen = new Set<number>();
  const out: FreezeMoment[] = [];
  for (const f of [...raw].sort((a, b) => a.beat_index - b.beat_index)) {
    const title = f.title.replace(/\s+/g, ' ').replace(/^["“']+|["”']+$/g, '').trim();
    const words = title.split(' ').filter(Boolean).length;
    if (!valid.has(f.beat_index) || seen.has(f.beat_index) || !title || words > 6) continue;
    seen.add(f.beat_index);
    out.push({ beat_index: f.beat_index, title: title.toUpperCase() });
  }
  return out.slice(0, maxFreezes(beats));
}

/** The saved plan while the narration is unchanged, otherwise a new one (saved for next time). */
export async function ensureEmphasisPlan(supabase: SupabaseClient, videoId: string, beats: Beat[]): Promise<EmphasisPlan> {
  const textHash = narrationHash(beats);
  const { data: row } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  const saved = row?.script_json?.emphasis_plan as EmphasisPlan | undefined;
  if (saved?.textHash === textHash) return saved;
  const { provider, ctx } = await resolveForStage<LLMProvider>('script', supabase);
  const { data } = await provider.generateJson(
    { system: 'You are a documentary editor with a sparing eye for emphasis.', prompt: buildEmphasisPrompt(beats), schema: Schema },
    ctx,
  );
  const plan: EmphasisPlan = { textHash, plannedAt: new Date().toISOString(), freezes: normalizeFreezes(data.freezes, beats) };
  const { data: latest } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  if (latest?.script_json) {
    await supabase.from('videos').update({ script_json: { ...latest.script_json, emphasis_plan: plan } }).eq('id', videoId);
  }
  console.log(`[Emphasis] Freeze-frames: ${plan.freezes.map((f) => `beat ${f.beat_index} "${f.title}"`).join(', ') || 'none'}`);
  return plan;
}

/** The freeze title card: a full-frame transparent PNG in the style's fonts and accent. */
export function freezeTitleDocument(theme: MotionTheme, title: string): string {
  return motionDocument({
    css: `html,body{background:transparent}
.ft{position:absolute;left:140px;bottom:190px;filter:drop-shadow(0 10px 30px rgba(0,0,0,.55))}
.t{font-family:${theme.headingFont};font-size:96px;font-weight:800;letter-spacing:2px;color:#fbf8f1;line-height:1}
.u{margin-top:18px;height:10px;width:220px;background:${theme.accent}}`,
    body: `<div class="ft"><div class="t">${escapeHtml(title)}</div><div class="u"></div></div>`,
    script: '',
  });
}

export async function renderFreezeTitles(theme: MotionTheme, titles: string[], dir: string): Promise<string[]> {
  if (titles.length === 0) return [];
  await fs.mkdir(dir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const out: string[] = [];
    for (const [i, title] of titles.entries()) {
      const page = await browser.newPage({ viewport: { width: FRAME_WIDTH, height: FRAME_HEIGHT } });
      try {
        await page.setContent(freezeTitleDocument(theme, title), { waitUntil: 'load' });
        await page.evaluate(() => document.fonts?.ready);
        const file = path.join(dir, `freeze_${i}.png`);
        await page.screenshot({ path: file, omitBackground: true });
        out.push(file);
      } finally {
        await page.close().catch(() => {});
      }
    }
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Freeze lengths: up to 2.5 s of the beat's voice, never overlapping the next freeze. */
export function freezeWindows(
  freezes: FreezeMoment[],
  voices: Record<number, { startMs: number; endMs: number }>,
): Array<{ beat_index: number; title: string; atSec: number; durSec: number }> {
  const out: Array<{ beat_index: number; title: string; atSec: number; durSec: number }> = [];
  for (const f of freezes) {
    const v = voices[f.beat_index];
    if (!v) continue;
    const atSec = v.startMs / 1000;
    const durSec = Math.min(MAX_FREEZE_SEC, Math.max(MIN_FREEZE_SEC, (v.endMs - v.startMs) / 1000));
    if (out.some((o) => atSec < o.atSec + o.durSec + 1)) continue;
    out.push({ ...f, atSec, durSec });
  }
  return out;
}

const n3 = (x: number) => x.toFixed(3);

/**
 * The emphasis part of the mastering graph: reads [vin], writes [vfx]. Each effect is a short
 * stretch cut from the picture, changed, and laid back over the same moment, so only those
 * seconds are touched. Freeze titles are extra inputs starting at `firstInput`.
 */
export function emphasisGraph(w: Omit<EmphasisWindows, 'letterboxPx'>, firstInput: number, size = { w: FRAME_WIDTH, h: FRAME_HEIGHT }, fps = FPS): string {
  const windows = [
    ...w.shakes.map((s) => ({ kind: 'shake' as const, at: s.atSec, dur: SHAKE_SEC })),
    ...w.zooms.map((z) => ({ kind: 'zoom' as const, at: z.atSec, dur: ZOOM_SEC })),
    ...w.freezes.map((f, i) => ({ kind: 'freeze' as const, at: f.atSec, dur: f.durSec, png: firstInput + i })),
  ].filter((x) => x.at >= 0 && x.dur > 0);
  if (windows.length === 0) return '[vin]null[vfx]';

  const parts = [`[vin]split=${windows.length + 1}[m0]${windows.map((_, i) => `[w${i}]`).join('')}`];
  windows.forEach((x, i) => {
    const cut = `[w${i}]trim=start=${n3(x.at)}:end=${n3(x.at + x.dur)},setpts=PTS-STARTPTS`;
    const back = `setpts=PTS+${n3(x.at)}/TB`;
    if (x.kind === 'shake') {
      // A jolt that settles: the picture shifts inside a slightly tighter crop, decaying fast
      const a = SHAKE_PX;
      parts.push(
        `${cut},crop=w=iw-${2 * a}:h=ih-${2 * a}:x='${a}+${a}*sin(2*PI*13*t)*exp(-6*t)':y='${a}+${a}*cos(2*PI*11*t)*exp(-6*t)',scale=${size.w}:${size.h},${back}[o${i}]`,
      );
    } else if (x.kind === 'zoom') {
      // Punches in and eases back out to the normal frame
      const frames = Math.max(1, Math.round(x.dur * fps));
      parts.push(
        `${cut},zoompan=z='1+${ZOOM_FROM - 1}*pow(max(0,1-on/${frames}),2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${size.w}x${size.h}:fps=${fps},${back}[o${i}]`,
      );
    } else {
      // One frame held, slightly desaturated, flashing in from white, with the title over it
      const frames = Math.max(1, Math.round(x.dur * fps));
      parts.push(
        `[w${i}]trim=start=${n3(x.at)}:end=${n3(x.at + 1 / fps)},setpts=PTS-STARTPTS,loop=loop=${frames - 1}:size=1:start=0,setpts=N/${fps}/TB,eq=saturation=0.7,fade=t=in:st=0:d=0.25:color=white[f${i}]`,
        `[f${i}][${x.png}:v]overlay=shortest=1,${back}[o${i}]`,
      );
    }
  });
  windows.forEach((x, i) => {
    const out = i === windows.length - 1 ? '[vfx]' : `[m${i + 1}]`;
    parts.push(`[m${i}][o${i}]overlay=eof_action=pass:enable='between(t,${n3(x.at)},${n3(x.at + x.dur)})'${out}`);
  });
  return parts.join(';');
}

/** Letterbox bars, drawn after the grade (so they stay black) and before captions. */
export function letterboxFilter(px: number): string | null {
  return px > 0 ? `drawbox=x=0:y=0:w=iw:h=${px}:color=black:t=fill,drawbox=x=0:y=ih-${px}:w=iw:h=${px}:color=black:t=fill` : null;
}

/**
 * Everything mastering needs for emphasis, or null when there's nothing to do. Freeze titles are
 * planned (once per narration) and rendered here; a failure in any part drops only that part.
 */
export async function prepareEmphasis(options: {
  supabase: SupabaseClient;
  videoId: string;
  style?: string | null;
  theme: MotionTheme;
  beats: Array<{ index: number; text: string; voiceStartMs: number; voiceEndMs: number }>;
  /** Narration sound cues (impact sounds get a shake). */
  soundCues: Array<{ atMs: number; sound: string }>;
  chapterChangesMs: number[];
  /** Per-video settings: off entirely, and letterbox on/off (default: the style's). */
  settings?: { enabled?: boolean; letterbox?: boolean } | null;
  tempDir: string;
}): Promise<{ graph: string; inputs: string[]; letterbox: string | null; summary: string } | null> {
  const { settings } = options;
  if (settings?.enabled === false) return null;
  const pack = stylePack(options.style);
  const shakes = options.soundCues
    .filter((c) => IMPACT_SOUNDS.has(c.sound.replace(/^real:/, '')))
    .map((c) => ({ atSec: c.atMs / 1000 }));
  const zooms = pack?.emphasis?.chapterZoom ? options.chapterChangesMs.map((ms) => ({ atSec: ms / 1000 })) : [];
  const letterboxPx = (settings?.letterbox ?? pack?.emphasis?.letterbox) ? LETTERBOX_PX : 0;

  let freezes: EmphasisWindows['freezes'] = [];
  try {
    const beats = options.beats.filter((b) => b.text.trim());
    const plan = await ensureEmphasisPlan(options.supabase, options.videoId, beats);
    const windows = freezeWindows(plan.freezes, Object.fromEntries(beats.map((b) => [b.index, { startMs: b.voiceStartMs, endMs: b.voiceEndMs }])));
    const pngs = await renderFreezeTitles(options.theme, windows.map((w) => w.title), path.join(options.tempDir, 'emphasis'));
    freezes = windows.map((w, i) => ({ atSec: w.atSec, durSec: w.durSec, titlePng: pngs[i] })).filter((w) => w.titlePng);
  } catch (err) {
    console.warn('[Emphasis] Freeze-frames skipped:', err instanceof Error ? err.message.slice(0, 200) : err);
  }

  // A shake or zoom inside a freeze would fight it
  const clear = (t: number) => !freezes.some((f) => t > f.atSec - 0.6 && t < f.atSec + f.durSec);
  const windows = { shakes: shakes.filter((s) => clear(s.atSec)), zooms: zooms.filter((z) => clear(z.atSec)), freezes };
  const graph = emphasisGraph(windows, 1);
  const letterbox = letterboxFilter(letterboxPx);
  if (graph === '[vin]null[vfx]' && !letterbox) return null;
  return {
    graph,
    inputs: freezes.flatMap((f) => ['-loop', '1', '-i', f.titlePng]),
    letterbox,
    summary: `${windows.shakes.length} shake(s), ${freezes.length} freeze-frame(s), ${windows.zooms.length} chapter zoom(s)${letterbox ? ', letterbox' : ''}`,
  };
}
