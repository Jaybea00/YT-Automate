import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { shortBranding, type ChannelProfile } from '@/lib/channel/profile';
import { generateAssCaptions } from '../assembly/captions';
import { ensureSoundLibrary, soundPath } from '../assembly/sfx';
import { levelAudioInPlace } from '../assembly/level-audio';
import { getFfmpegPath } from '../utils/ffmpeg';
import {
  circleDocument,
  clipBand,
  comicFilter,
  dotsDocument,
  GRADE_FILTER,
  RECAP_BED_SOUNDS,
  RECAP_CLICK_SOUNDS,
  RECAP_LANDING_EMOJI,
  RECAP_RISE_SOUNDS,
  recapGraph,
  recapInputs,
  recapLength,
  recapShots,
  recapTimes,
  REWIND_SOUNDS,
  SKULL_SOUNDS,
  skullLookFilter,
  whipFilter,
  emojiDocument,
  emojiImageDocument,
  ENDING_DEFAULTS,
  endingDocument,
  endingFilter,
  flashFilter,
  framePoint,
  headerDocument,
  headerY,
  insideSkip,
  joinGraph,
  mixGraph,
  outputTime,
  parts,
  shakeFilter,
  shortDuration,
  timeline,
  zoomWindow,
  type TimedCutIn,
} from './reaction';
import { captionTrack, gameVolumeExpression, layoutBase, maskSwear, SHORT_H, SHORT_W, withClosing, zoomExpression } from './render';
import { emojiImageDataUrl, findEmojiImage, isEmojiChar } from './emojis';
import { findSound } from './sounds';
import type { ClipAnalysis, ClipPlan, Ending } from './types';


const execFileAsync = promisify(execFile);
const FPS = 30;
const fx = (n: number) => n.toFixed(3);
/** How long an emoji stays up, and how the blend back to the first frame lasts in a loop. */
const EMOJI_SEC = 1.1;
const LOOP_BLEND_SEC = 0.35;
/** How long a comic-dot flash lasts. */
const COMIC_SEC = 0.5;

type Picture = { file: string; html: string; crop: 'box' | 'full' | 'element'; selector?: string };

/** Draws pictures in a browser (so emoji come out in colour) as transparent PNGs; returns each one's size. */
export async function renderPictures(pictures: Picture[], viewport: { width: number; height: number } = { width: SHORT_W, height: SHORT_H }): Promise<Array<{ width: number; height: number }>> {
  if (!pictures.length) return [];
  const browser = await chromium.launch({ headless: true });
  try {
    // A wide picture (a card across a 1920-wide video) needs a page wide enough to hold it
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const sizes: Array<{ width: number; height: number }> = [];
    for (const p of pictures) {
      await page.setContent(p.html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      if (p.crop === 'full') {
        await page.screenshot({ path: p.file, omitBackground: true, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } });
        sizes.push({ width: viewport.width, height: viewport.height });
        continue;
      }
      const box = await page.locator(p.selector ?? 'body > *').first().boundingBox();
      if (!box) throw new Error('a picture did not draw');
      // The header keeps the full width (and room for its shadow); other pictures are cut to their element, plus a margin
      const clip =
        p.crop === 'box'
          ? { x: 0, y: 0, width: SHORT_W, height: Math.ceil(box.y + box.height + 36) }
          : { x: Math.max(0, Math.floor(box.x - 30)), y: Math.max(0, Math.floor(box.y - 30)), width: Math.ceil(box.width + 60), height: Math.ceil(box.height + 60) };
      await page.screenshot({ path: p.file, omitBackground: true, clip });
      sizes.push({ width: clip.width, height: clip.height });
    }
    return sizes;
  } finally {
    await browser.close();
  }
}

/** The ending as it will play, or null. */
const activeEnding = (plan: ClipPlan): Ending | null => (plan.ending && plan.ending.style !== 'none' ? plan.ending : null);

/**
 * Renders a reaction edit: the clip with its cut-ins joined in order, a zoom aimed at the big
 * moment, hits, emoji, a circle on the freeze, captions on the Short's own clock, the header box,
 * the ending (or a blend back to the first frame), voice lines and sounds mixed in, then levelled
 * to the feed's loudness.
 */
export async function renderReactionShort(dir: string, sourceFile: string, plan: ClipPlan, analysis: ClipAnalysis, channel?: ChannelProfile): Promise<{ video: string; thumbnail: string; durationSec: number }> {
  const clipSec = Math.max(1, plan.trimEnd - plan.trimStart);
  const { cutIns, voiceLines } = timeline(plan);
  const ending = activeEnding(plan);
  // A recap is a second pass over the finished Short (it replays the edit's own highlights)
  const recapOn = ending?.style === 'recap';
  const endingSec = recapOn ? 0 : (ending?.durationSec ?? 0);
  const mainSec = shortDuration(clipSec, cutIns);
  const durationSec = mainSec + endingSec;
  const loop = !!plan.loop && !ending;
  const map = (sec: number) => outputTime(sec, plan.trimStart, cutIns);
  // A moment counts when it's inside the trim and not in a stretch that's cut out
  const inClip = (sec: number | null | undefined): sec is number => sec != null && sec >= plan.trimStart && sec < plan.trimEnd && !insideSkip(sec, plan.cutIns ?? []);
  // Each cut-in's edges on the Short's clock (a cut-out is one edge: the jump)
  // (a teaser: into its rewind, and out of it into the story)
  const teaser = cutIns.find((c) => c.kind === 'teaser') ?? null;
  const cutEdges = cutIns
    .filter((c) => c.kind !== 'ramp')
    .flatMap((c) => (c.kind === 'skip' ? [c.outAt] : c.kind === 'teaser' ? [c.replaySec ?? 0, c.durationSec] : [c.outAt, c.outAt + c.durationSec]));
  const recap = recapOn
    ? recapShots({
        cutIns,
        emojiAt: (plan.effects ?? []).filter((e) => e.kind === 'emoji' && inClip(e.at)).map((e) => map(e.at)),
        peakOut: inClip(plan.peakSec) ? map(plan.peakSec) : null,
        avoid: plan.whipBlur === false ? [] : cutEdges,
        mainSec,
      })
    : null;
  const totalSec = durationSec + (recap ? recapLength(recap.shots, recap.landing) : 0);
  const work = path.join(dir, 'render-pictures');
  await fs.mkdir(path.join(dir, 'export'), { recursive: true });
  await fs.mkdir(work, { recursive: true });

  // Captions and banners on the Short's clock
  const header = plan.header?.text?.trim() ? plan.header : null;
  // Words and voice lines inside a cut-out are left out with it
  const track = captionTrack(
    { ...plan, voiceLines: voiceLines.filter((l) => !insideSkip(l.at, plan.cutIns ?? [])) },
    { ...analysis, words: analysis.words.filter((w) => !insideSkip(w.start, plan.cutIns ?? [])) },
    { map, durationSec: mainSec, hideHook: !!header },
  );
  if (teaser && plan.captions) {
    // The teased words are captioned at the start too (the rewind runs without captions)
    const from = (teaser.teaseTo ?? 0) - (teaser.replaySec ?? 0);
    for (const w of analysis.words) {
      const rel = w.start - plan.trimStart - from;
      if (rel < 0 || rel >= (teaser.replaySec ?? 0) - 0.1) continue;
      track.words.push({ word: plan.cleanCaptions !== false ? maskSwear(w.word) : w.word, start: rel, end: Math.min(rel + (w.end - w.start), teaser.replaySec ?? 0) });
    }
    track.words.sort((a, b) => a.start - b.start);
  }
  // The closing line belongs to the very end: with a recap, the second pass draws it
  const brand = channel ? shortBranding(channel, Math.round(totalSec * 1000)) : null;
  const banners = withClosing(track.banners, brand?.closing ?? null);
  const quiet = cutIns.filter((c) => c.kind === 'meme').map((c) => ({ startMs: Math.round(c.outAt * 1000), endMs: Math.round((c.outAt + c.durationSec) * 1000) }));
  if (ending && !recapOn) quiet.push({ startMs: Math.round(mainSec * 1000), endMs: Math.round(durationSec * 1000) + 1000 });
  // No spoken-word captions once the crossfade into the recap starts
  if (recapOn) quiet.push({ startMs: Math.round((mainSec - 0.3) * 1000), endMs: Math.round(totalSec * 1000) + 1000 });
  if (teaser) quiet.push({ startMs: Math.round((teaser.replaySec ?? 0) * 1000), endMs: Math.round(teaser.durationSec * 1000) });
  for (const c of cutIns) if (c.kind === 'skull') quiet.push({ startMs: Math.round(c.outAt * 1000), endMs: Math.round((c.outAt + c.durationSec) * 1000) });
  const { assContent } = generateAssCaptions({
    beats: [{ index: 0, text: '' }],
    units: [{ unit_index: 0, duration_ms: Math.round(durationSec * 1000) }],
    beatStartMs: [0],
    words: { 0: track.words },
    preset: 'social_pop',
    highlightHex: brand?.highlightHex ?? '#ffd400',
    bannerHex: brand?.bannerHex,
    fontName: brand?.fontName,
    mark: brand?.mark,
    resolution: { width: SHORT_W, height: SHORT_H },
    fontSize: 80,
    marginV: 420,
    banners,
    // The meme (and the ending) speak for themselves: no game captions over them
    quiet,
    glow: plan.glowCaptions !== false,
  });
  const assName = 'short.ass';
  await fs.writeFile(path.join(dir, assName), assContent, 'utf-8');

  // Inputs: the clip, the memes, the voice lines, the sounds, then the pictures
  const inputs = ['-ss', fx(plan.trimStart), '-t', fx(clipSec), '-i', path.join(dir, sourceFile)];
  let next = 1;
  const memeInputs = new Map<TimedCutIn, number>();
  for (const c of cutIns) {
    if (c.kind !== 'meme' || !c.meme) continue;
    memeInputs.set(c, next++);
    inputs.push('-stream_loop', '-1', '-t', fx(c.durationSec + 0.3), '-i', path.join(dir, c.meme.file));
  }
  const voices: Array<{ input: number; atSec: number }> = [];
  const duck: Array<{ start: number; end: number }> = [];
  if (plan.voiceover) {
    for (const line of voiceLines) {
      if (!line.audioFile || !inClip(line.at)) continue;
      const at = map(line.at) + (line.offsetSec ?? 0);
      voices.push({ input: next++, atSec: at });
      inputs.push('-i', path.join(dir, line.audioFile));
      duck.push({ start: Math.max(0, at - 0.1), end: at + (line.durationSec ?? 2) + 0.15 });
    }
  }
  const sfx: Array<{ input: number; atSec: number; volume: number }> = [];
  const addSound = (file: string, atSec: number, volume: number) => {
    sfx.push({ input: next++, atSec: Math.max(0, atSec), volume });
    inputs.push('-i', file);
  };
  await ensureSoundLibrary();
  const peak = inClip(plan.peakSec) ? plan.peakSec : null;
  const effects = (plan.effects ?? []).filter((e) => inClip(e.at));
  if (plan.sfxOnPeak && peak != null) addSound(soundPath('impact'), map(peak) - 0.05, 0.55);
  for (const e of effects) if (e.kind === 'shake' && (peak == null || Math.abs(e.at - peak) > 0.3)) addSound(soundPath('impact'), map(e.at) - 0.05, 0.4);
  for (const e of effects) if (e.kind === 'sound' && e.sound) addSound(path.join(dir, e.sound.file), map(e.at), 1);
  for (const c of cutIns) if (c.kind === 'meme' || c.kind === 'replay') addSound(soundPath('whoosh'), c.outAt - 0.15, 0.7);
  const freezes = cutIns.filter((c) => c.kind === 'freeze');
  if (freezes.length) {
    const scratch = await findSound(dir, 'record scratch').catch(() => null);
    if (scratch) for (const c of freezes) addSound(path.join(dir, scratch.file), c.outAt, 0.8);
  }
  const skulls = cutIns.filter((c) => c.kind === 'skull');
  if (skulls.length) {
    let boom = null;
    for (const q of SKULL_SOUNDS) if (!boom) boom = await findSound(dir, q).catch(() => null);
    if (boom) for (const c of skulls) addSound(path.join(dir, boom.file), c.outAt, 1);
  }
  if (teaser) {
    // A tape-rewind sound under the wind-back (from the user's library), else a whoosh
    let rewind = null;
    for (const q of REWIND_SOUNDS) if (!rewind) rewind = await findSound(dir, q).catch(() => null);
    addSound(rewind ? path.join(dir, rewind.file) : soundPath('whoosh'), (teaser.replaySec ?? 0) - 0.1, 0.8);
  }
  const comics = effects.filter((e) => e.kind === 'comic').map((e) => map(e.at));
  for (const t of comics) addSound(soundPath('impact'), t - 0.03, 0.45);
  if (ending?.sound && !recapOn) addSound(path.join(dir, ending.sound.file), mainSec - ENDING_DEFAULTS[ending.style as keyof typeof ENDING_DEFAULTS].leadSec, 1);

  // Pictures
  const band = clipBand(plan.layout, analysis.width, analysis.height);
  const pictures: Array<Picture & { overlay: (label: string, input: number, size: { width: number; height: number }) => string }> = [];
  const enable = (from: number, to: number) => `enable='between(t,${fx(from)},${fx(to)})'`;
  if (header && !recapOn) {
    pictures.push({
      file: path.join(work, 'header.png'),
      html: headerDocument(header, brand?.fontName),
      crop: 'box',
      selector: '#box',
      overlay: (l, i, s) => `${l}[${i}:v]overlay=0:${headerY(plan.layout, analysis.width, analysis.height, s.height - 36)}${ending?.style === 'credits' ? `:${enable(0, mainSec)}` : ''}`,
    });
  }
  for (const [k, c] of freezes.entries()) {
    if (!c.focus) continue;
    const at = framePoint(plan.layout, analysis.width, analysis.height, c.focus);
    pictures.push({
      file: path.join(work, `circle_${k}.png`),
      html: circleDocument(at),
      crop: 'full',
      overlay: (l, i) => `[${i}:v]format=rgba,fade=t=in:st=${fx(c.outAt + 0.08)}:d=0.15:alpha=1[ci${k}];${l}[ci${k}]overlay=0:0:${enable(c.outAt, c.outAt + c.durationSec)}`,
    });
  }
  for (const [k, e] of effects.filter((x) => x.kind === 'emoji' && x.emoji).entries()) {
    const t = map(e.at);
    // A typed emoji is drawn as text; a name is a picture from the emoji library (skipped when none matches)
    let html = emojiDocument(e.emoji!);
    if (!isEmojiChar(e.emoji!.replace(/\s+/g, ''))) {
      const file = await findEmojiImage(e.emoji!);
      if (!file) {
        console.warn(`[Reaction] No emoji picture named like "${e.emoji}" in the emoji library; left out`);
        continue;
      }
      html = emojiImageDocument(await emojiImageDataUrl(file));
    }
    const x = k % 2 === 0 ? SHORT_W - 360 : 40;
    const y0 = band.top + 30;
    pictures.push({
      file: path.join(work, `emoji_${k}.png`),
      html,
      crop: 'element',
      selector: '#e',
      overlay: (l, i) =>
        `[${i}:v]format=rgba,fade=t=in:st=${fx(t)}:d=0.1:alpha=1,fade=t=out:st=${fx(t + EMOJI_SEC - 0.25)}:d=0.25:alpha=1[em${k}];` +
        `${l}[em${k}]overlay=x=${x}:y='${y0}-90*(t-${fx(t)})':${enable(t, t + EMOJI_SEC)}`,
    });
  }
  if (teaser) {
    // ⏪ in the middle of the picture while it winds back
    const from = teaser.replaySec ?? 0;
    pictures.push({
      file: path.join(work, 'rewind.png'),
      html: emojiDocument('⏪', 260),
      crop: 'element',
      selector: '#e',
      overlay: (l, i, sz) => `${l}[${i}:v]overlay=x=(W-w)/2:y=${Math.round((band.top + band.bottom) / 2 - sz.height / 2)}:${enable(from, teaser.durationSec)}`,
    });
  }
  const skullHtml = async (emoji?: string) => {
    // A plain skull (or none) uses the library's skull picture when there is one: it looks like the trend's white skull
    const asked = (emoji ?? '').trim();
    const e = !asked || asked === '💀' || asked === '☠️' ? ((await findEmojiImage('skull dead')) ? 'skull dead' : '💀') : asked;
    if (isEmojiChar(e.replace(/\s+/g, ''))) return emojiDocument(e, 300);
    const file = await findEmojiImage(e);
    return file ? emojiImageDocument(await emojiImageDataUrl(file), 340) : emojiDocument('💀', 300);
  };
  const skullWindows = [
    ...skulls.map((c) => ({ from: c.outAt, to: c.outAt + c.durationSec, emoji: c.emoji })),
    ...(ending?.style === 'skull' ? [{ from: mainSec, to: durationSec, emoji: ending.emoji }] : []),
  ];
  for (const [k, w] of skullWindows.entries()) {
    pictures.push({
      file: path.join(work, `skull_${k}.png`),
      html: await skullHtml(w.emoji),
      crop: 'element',
      selector: '#e',
      overlay: (l, i, sz) =>
        `[${i}:v]format=rgba,fade=t=in:st=${fx(w.from + 0.04)}:d=0.05:alpha=1[sk${k}];` +
        `${l}[sk${k}]overlay=x=(W-w)/2:y=${Math.round((band.top + band.bottom) / 2 - sz.height / 2)}:${enable(w.from, w.to)}`,
    });
  }
  if (comics.length) {
    const windows = comics.map((t) => `between(t,${fx(t)},${fx(t + COMIC_SEC)})`).join('+');
    pictures.push({ file: path.join(work, 'dots.png'), html: dotsDocument(), crop: 'full', overlay: (l, i) => `${l}[${i}:v]overlay=0:0:enable='${windows}'` });
  }
  const shakes = effects.filter((e) => e.kind === 'shake').map((e) => map(e.at));
  if (ending && (ending.style === 'tbc' || ending.style === 'credits' || ending.style === 'stamp')) {
    const style = ending.style;
    const from = mainSec;
    if (style === 'stamp') shakes.push(from + 0.05);
    pictures.push({
      file: path.join(work, 'ending.png'),
      html: endingDocument(style, ending.text),
      crop: style === 'credits' ? 'full' : 'element',
      selector: style === 'tbc' ? '#c' : '#s',
      overlay: (l, i, s) => {
        if (style === 'credits') return `[${i}:v]format=rgba,fade=t=in:st=${fx(from + 0.25)}:d=0.35:alpha=1[en];${l}[en]overlay=0:0:${enable(from, durationSec)}`;
        if (style === 'stamp') {
          const y = Math.round((band.top + band.bottom) / 2 - s.height / 2);
          return `[${i}:v]format=rgba,fade=t=in:st=${fx(from + 0.05)}:d=0.06:alpha=1[en];${l}[en]overlay=x=(W-w)/2:y=${y}:${enable(from, durationSec)}`;
        }
        const y = Math.max(band.top, band.bottom - s.height - 24);
        return `${l}[${i}:v]overlay=x='if(lt(t,${fx(from + 0.35)}),-w+(t-${fx(from)})/0.35*(w+20),20)':y=${y}:${enable(from, durationSec)}`;
      },
    });
  }
  const sizes = await renderPictures(pictures);
  const pictureInputs = pictures.map((p) => {
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', fx(durationSec), '-i', p.file);
    return next++;
  });

  // Picture: join, (blend into the start), zoom, shake, flash, ending look, captions, pictures, fades
  const mute = plan.muteMusic ? analysis.musicSections.map((m) => ({ start: Math.max(0, m.start - plan.trimStart), end: m.end - plan.trimStart })).filter((m) => m.end > 0) : [];
  const join = joinGraph({ base: layoutBase(plan.layout), parts: parts(clipSec, cutIns, memeInputs, endingSec), hasAudio: analysis.hasAudio, clipSec, muteExpr: gameVolumeExpression([], mute), fps: FPS });
  const peakOut = peak != null ? map(peak) : null;
  const flashes = effects.filter((e) => e.kind === 'flash').map((e) => map(e.at));
  if (ending?.style === 'skull') shakes.push(mainSec + 0.04);
  for (const c of skulls) shakes.push(c.outAt + 0.04);
  // Whips: into and out of every cut-in (a ramp is a slow-down, not a cut), into the ending, between recap cuts
  const whips =
    plan.whipBlur === false
      ? []
      : [...cutEdges, ...(ending && !recapOn ? [mainSec] : [])].filter((t) => t > 0.1 && t < durationSec - 0.1);
  const focus = plan.zoomFocus ? framePoint(plan.layout, analysis.width, analysis.height, plan.zoomFocus) : null;
  const win = zoomWindow(focus);
  const chains: string[] = [join];
  let label = '[cv]';
  if (loop) {
    // The last moments blend into the Short's first frame, so the replay starts without a jump
    chains.push(`[cv]split=2[cvm][cvf];[cvf]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${fx(LOOP_BLEND_SEC + 0.2)}[first];[cvm][first]xfade=transition=fade:duration=${fx(LOOP_BLEND_SEC)}:offset=${fx(Math.max(0.5, mainSec - LOOP_BLEND_SEC))}[cvl]`);
    label = '[cvl]';
  }
  const look = [
    plan.zoomOnPeak && peakOut != null ? `zoompan=z='${zoomExpression(peakOut)}':x='${win.x}':y='${win.y}':d=1:s=${SHORT_W}x${SHORT_H}:fps=${FPS}` : null,
    plan.grade ? GRADE_FILTER : null,
    shakeFilter(shakes),
    whipFilter(whips),
    skullLookFilter(skulls.map((c) => ({ from: c.outAt, to: c.outAt + c.durationSec }))),
    comicFilter(comics.map((t) => ({ from: t, to: t + COMIC_SEC }))),
    flashFilter(flashes),
    ending ? endingFilter(ending.style, mainSec, durationSec) : null,
    recapOn ? null : `ass=${assName}`,
  ].filter(Boolean).join(',');
  chains.push(`${label}${look}[lk0]`);
  label = '[lk0]';
  for (const [k, p] of pictures.entries()) {
    chains.push(`${p.overlay(label, pictureInputs[k], sizes[k])}[lk${k + 1}]`);
    label = `[lk${k + 1}]`;
  }
  // No fade from or to black: the Short opens on its header and ends on a cut
  chains.push(`${label}format=yuv420p[v]`);
  chains.push(mixGraph({ durationSec, duck, voices, sfx }));
  const graph = chains.join(';');

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
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
  let finished = tmp;
  if (recap && (recap.shots.length || recap.landing != null)) {
    finished = path.join(dir, 'export', 'short.recap.mp4');
    try {
      await renderRecap({
        dir,
        main: tmp,
        out: finished,
        mainSec,
        recap,
        ending: ending!,
        brand,
        focus,
        band,
        totalSec,
        skullHtml,
        captions: assContent,
        header: header ? { html: headerDocument(header, brand?.fontName), y: (boxHeight: number) => headerY(plan.layout, analysis.width, analysis.height, boxHeight) } : null,
      });
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }
  await levelAudioInPlace(finished);
  await fs.rename(finished, out);

  const thumbAt = peakOut != null ? peakOut + 0.2 : mainSec / 2;
  const thumb = path.join(dir, 'export', 'thumbnail.jpg');
  await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', fx(Math.min(thumbAt, durationSec - 0.1)), '-i', out, '-frames:v', '1', '-q:v', '2', thumb]).catch(() => {});

  return { video: 'export/short.mp4', thumbnail: 'export/thumbnail.jpg', durationSec: Number(totalSec.toFixed(2)) };
}

/**
 * The recap ending, as a second pass over the finished Short: its own highlights replayed a little
 * slow with soft crossfades (white into the recap), a slow push in on the big moment with a skull
 * and its hit, the closing line over the end, then a cut.
 */
async function renderRecap(o: {
  dir: string;
  main: string;
  out: string;
  mainSec: number;
  recap: { shots: number[]; landing: number | null };
  ending: Ending;
  brand: ReturnType<typeof shortBranding> | null;
  focus: { x: number; y: number } | null;
  band: { top: number; bottom: number };
  totalSec: number;
  skullHtml: (emoji?: string) => Promise<string>;
  /** The header box, laid over the whole Short here (so the recap's push-ins don't crop it). */
  header: { html: string; y: (boxHeight: number) => number } | null;
  /** The Short's caption track (words over the main part, the @handle, the closing line). */
  captions: string;
}): Promise<void> {
  const { dir, mainSec, recap, totalSec } = o;
  const work = path.join(dir, 'recap-pictures');
  await fs.mkdir(work, { recursive: true });
  const inputs = recapInputs(o.main, recap.shots, recap.landing);
  let next = 1 + recap.shots.length + (recap.landing != null ? 1 : 0);
  const chains = [recapGraph({ mainSec, shots: recap.shots, landing: recap.landing, focus: o.focus, fps: FPS }).replace('[ra]', '[ca]')];
  const { transitions, landingStart } = recapTimes(mainSec, recap.shots, recap.landing);
  let label = '[rv]';
  const assName = 'recap.ass';
  try {
    // The skull on the landing
    if (landingStart != null) {
      const png = path.join(work, 'landing.png');
      // The ending's own emoji, else the exploding skull (the skull hit already used the plain one)
      const [size] = await renderPictures([{ file: png, html: await o.skullHtml(o.ending.emoji?.trim() || RECAP_LANDING_EMOJI), crop: 'element', selector: '#e' }]);
      const at = landingStart + 0.35;
      inputs.push('-loop', '1', '-framerate', String(FPS), '-t', fx(totalSec), '-i', png);
      chains.push(
        `[${next}:v]format=rgba,fade=t=in:st=${fx(at)}:d=0.08:alpha=1[sk];${label}[sk]overlay=x=(W-w)/2:y=${Math.round((o.band.top + o.band.bottom) / 2 - size.height / 2)}:enable='gte(t,${fx(at)})'[rs]`,
      );
      next++;
      label = '[rs]';
    }
    // The header box over the whole Short
    if (o.header) {
      const png = path.join(work, 'header.png');
      const [size] = await renderPictures([{ file: png, html: o.header.html, crop: 'box', selector: '#box' }]);
      inputs.push('-loop', '1', '-framerate', String(FPS), '-t', fx(totalSec), '-i', png);
      chains.push(`${label}[${next}:v]overlay=0:${o.header.y(size.height - 36)}[rh]`);
      next++;
      label = '[rh]';
    }
    // The captions, the @handle and the closing line ("Follow for daily GTA 6"), on top of it all
    await fs.writeFile(path.join(dir, assName), o.captions, 'utf-8');
    chains.push(`${label}ass=${assName}[rc]`);
    label = '[rc]';
    chains.push(`${label}format=yuv420p[v]`);

    // Sounds: a rise into the white flash and a camera click on it (so the recap sounds meant), a music
    // bed under the silent shots until the landing, a soft whoosh between shots, the ending's hit on the landing
    await ensureSoundLibrary();
    const firstSound = async (queries: string[]) => {
      for (const q of queries) {
        const found = await findSound(dir, q).catch(() => null);
        if (found) return found;
      }
      return null;
    };
    const sfx: Array<{ input: number; atSec: number; volume: number; lengthSec?: number }> = [];
    const add = (file: string, atSec: number, volume: number, lengthSec?: number) => {
      sfx.push({ input: next++, atSec: Math.max(0, atSec), volume, ...(lengthSec ? { lengthSec } : {}) });
      inputs.push('-i', file);
    };
    const flashAt = transitions[0];
    if (flashAt != null) {
      const rise = await firstSound(RECAP_RISE_SOUNDS);
      if (rise) add(path.join(dir, rise.file), flashAt - Math.min(0.8, rise.durationSec * 0.6), 0.6);
      const click = await firstSound(RECAP_CLICK_SOUNDS);
      if (click) add(path.join(dir, click.file), flashAt + 0.05, 0.8);
      const bed = await firstSound(RECAP_BED_SOUNDS);
      const bedEnd = landingStart ?? totalSec;
      if (bed && bedEnd - flashAt > 0.5) add(path.join(dir, bed.file), flashAt, 0.55, Math.min(bed.durationSec, bedEnd - flashAt + 0.3));
    }
    for (const t of transitions.slice(1)) add(soundPath('whoosh'), t - 0.05, 0.3);
    if (landingStart != null && o.ending.sound) add(path.join(dir, o.ending.sound.file), landingStart + 0.35, 1);
    chains.push(mixGraph({ durationSec: totalSec, duck: [], voices: [], sfx }));

    await execFileAsync(
      getFfmpegPath(),
      [
        '-y', '-hide_banner', '-v', 'error', ...inputs,
        '-filter_complex', chains.join(';'),
        '-map', '[v]', '-map', '[a]',
        '-t', fx(totalSec),
        '-c:v', 'libx264', '-preset', 'faster', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(FPS),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', o.out,
      ],
      { cwd: dir, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60_000 },
    );
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    throw new Error(`The recap ending failed: ${(stderr || (err instanceof Error ? err.message : String(err))).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  } finally {
    await fs.unlink(path.join(dir, assName)).catch(() => {});
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
