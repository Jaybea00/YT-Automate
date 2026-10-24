import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { motionDocument, FRAME_HEIGHT, FRAME_WIDTH } from '../visuals/motion/frame-renderer';
import { escapeHtml } from '../visuals/motion/templates';
import type { MotionTheme } from '../visuals/motion/theme';

/**
 * The creator's own on-screen additions from Vibedit (script_json.overlays): a line of text, a
 * callout (a label with a leader line to a point), or an arrow pointing at something, at any
 * moment. Each is anchored to a beat (seconds from the beat's start), so it stays on its moment
 * when timings change, and is drawn over the picture in mastering (under the captions).
 */
export type OverlayKind = 'text' | 'callout' | 'arrow';

export interface Overlay {
  id: string;
  kind: OverlayKind;
  beat: number;
  /** Seconds from the beat's scene start. */
  offsetSec: number;
  durationSec: number;
  text: string;
  /** Where on the frame (0-1): the text's centre, or the point the callout/arrow marks. */
  x: number;
  y: number;
}

export const MAX_OVERLAYS = 200;
const FADE_SEC = 0.3;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** A submitted overlay kept sane, or null when it can't be shown. */
export function normalizeOverlay(raw: unknown, id?: string): Overlay | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = r.kind;
  if (kind !== 'text' && kind !== 'callout' && kind !== 'arrow') return null;
  const beat = Number(r.beat);
  const offsetSec = Number(r.offsetSec);
  const durationSec = Number(r.durationSec);
  const x = Number(r.x);
  const y = Number(r.y);
  const text = typeof r.text === 'string' ? r.text.trim().slice(0, 120) : '';
  if (!Number.isInteger(beat) || beat < 0 || !Number.isFinite(offsetSec) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!text && kind !== 'arrow') return null;
  return {
    id: id ?? (typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) ? r.id : `${Date.now()}${Math.random().toString(36).slice(2, 6)}`),
    kind,
    beat,
    offsetSec: Math.round(Math.max(0, offsetSec) * 10) / 10,
    durationSec: Math.round(Math.max(0.8, Math.min(15, Number.isFinite(durationSec) ? durationSec : 3)) * 10) / 10,
    text,
    x: Math.round(clamp01(x) * 1000) / 1000,
    y: Math.round(clamp01(y) * 1000) / 1000,
  };
}

export function readOverlays(raw: unknown): Overlay[] {
  return Array.isArray(raw) ? raw.map((o) => normalizeOverlay(o, (o as { id?: string })?.id)).filter((o): o is Overlay => Boolean(o)) : [];
}

/** When each overlay shows in the finished video, from where its beat starts (beats not in the video are left out). */
export function overlayWindows(overlays: Overlay[], beatStartSec: Record<number, number>, totalSec: number): Array<Overlay & { atSec: number; endSec: number }> {
  return overlays
    .filter((o) => beatStartSec[o.beat] !== undefined)
    .map((o) => {
      const atSec = beatStartSec[o.beat] + o.offsetSec;
      return { ...o, atSec, endSec: Math.min(totalSec || Infinity, atSec + o.durationSec) };
    })
    .filter((o) => o.endSec - o.atSec >= 0.3)
    .sort((a, b) => a.atSec - b.atSec);
}

/** The overlay's artwork: a transparent 1920x1080 page. */
export function overlayDocument(theme: MotionTheme, o: Overlay): string {
  const W = FRAME_WIDTH;
  const H = FRAME_HEIGHT;
  const px = o.x * W;
  const py = o.y * H;
  const label = escapeHtml(o.text);
  const box = `font-family:${theme.headingFont};font-weight:800;color:#fbf8f1;background:rgba(12,12,14,.82);border-left:10px solid ${theme.accent};padding:18px 28px;border-radius:6px;box-shadow:0 14px 40px rgba(0,0,0,.45);white-space:nowrap`;
  if (o.kind === 'text') {
    return motionDocument({
      css: `html,body{background:transparent}.t{position:absolute;left:${px}px;top:${py}px;transform:translate(-50%,-50%);font-size:64px;${box}}`,
      body: `<div class="t">${label}</div>`,
      script: '',
    });
  }
  // Callouts and arrows lean toward the frame's centre, so the label stays on screen
  const dx = px < W / 2 ? 1 : -1;
  const dy = py < H / 2 ? 1 : -1;
  const reach = o.kind === 'arrow' ? 230 : 190;
  const tx = px + dx * reach;
  const ty = py + dy * reach * 0.62;
  const angle = Math.atan2(py - ty, px - tx);
  const head = 34;
  const hx = px - Math.cos(angle) * 6;
  const hy = py - Math.sin(angle) * 6;
  const left = (a: number) => `${hx - head * Math.cos(angle - a)},${hy - head * Math.sin(angle - a)}`;
  const svg =
    o.kind === 'arrow'
      ? `<line x1="${tx}" y1="${ty}" x2="${px - Math.cos(angle) * 26}" y2="${py - Math.sin(angle) * 26}" stroke="${theme.accent}" stroke-width="12" stroke-linecap="round"/>
         <polygon points="${hx},${hy} ${left(0.45)} ${left(-0.45)}" fill="${theme.accent}"/>`
      : `<line x1="${tx}" y1="${ty}" x2="${px}" y2="${py}" stroke="#fbf8f1" stroke-width="5"/>
         <circle cx="${px}" cy="${py}" r="26" fill="none" stroke="${theme.accent}" stroke-width="7"/>
         <circle cx="${px}" cy="${py}" r="7" fill="${theme.accent}"/>`;
  const labelCss = `position:absolute;top:${ty}px;${dx > 0 ? `left:${tx - 6}px` : `right:${W - tx - 6}px`};transform:translateY(${dy > 0 ? '0' : '-100%'});font-size:${o.kind === 'arrow' ? 44 : 40}px;${box}`;
  return motionDocument({
    css: `html,body{background:transparent}svg{position:absolute;inset:0;filter:drop-shadow(0 6px 14px rgba(0,0,0,.5))}.l{${labelCss}}`,
    body: `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svg}</svg>${label ? `<div class="l">${label}</div>` : ''}`,
    script: '',
  });
}

export async function renderOverlayPngs(theme: MotionTheme, overlays: Overlay[], dir: string): Promise<string[]> {
  if (overlays.length === 0) return [];
  await fs.mkdir(dir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const out: string[] = [];
    for (const o of overlays) {
      const page = await browser.newPage({ viewport: { width: FRAME_WIDTH, height: FRAME_HEIGHT } });
      try {
        await page.setContent(overlayDocument(theme, o), { waitUntil: 'load' });
        await page.evaluate(() => document.fonts?.ready);
        const file = path.join(dir, `overlay_${o.id}.png`);
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

const n3 = (x: number) => x.toFixed(3);

/**
 * The overlays part of the mastering graph: reads [vfx], writes [vov]. Each PNG is an input
 * (from `firstInput`), held until its end and faded in and out over its window.
 */
export function overlaysGraph(windows: Array<{ atSec: number; endSec: number }>, firstInput: number): string {
  if (windows.length === 0) return '[vfx]null[vov]';
  const parts: string[] = [];
  windows.forEach((w, i) => {
    const fade = Math.min(FADE_SEC, (w.endSec - w.atSec) / 3);
    parts.push(
      `[${firstInput + i}:v]format=rgba,fade=t=in:st=${n3(w.atSec)}:d=${n3(fade)}:alpha=1,fade=t=out:st=${n3(w.endSec - fade)}:d=${n3(fade)}:alpha=1[ovl${i}]`,
      `[${i === 0 ? 'vfx' : `ovc${i - 1}`}][ovl${i}]overlay=eof_action=pass:enable='between(t,${n3(w.atSec)},${n3(w.endSec)})'${i === windows.length - 1 ? '[vov]' : `[ovc${i}]`}`,
    );
  });
  return parts.join(';');
}

/** The ffmpeg inputs for the overlay PNGs: each held as a still until its window ends. */
export function overlayInputs(windows: Array<{ endSec: number }>, pngs: string[]): string[] {
  return pngs.flatMap((png, i) => ['-loop', '1', '-framerate', '30', '-t', n3(windows[i].endSec + 0.1), '-i', png]);
}
