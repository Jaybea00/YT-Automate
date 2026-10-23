import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright';
import { z } from 'zod';
import { numbersIn } from '@/lib/script/shot-planner';
import type { LLMProvider, LlmImage, ProviderCallContext } from '../providers/types';
import { getFfmpegPath } from '../utils/ffmpeg';
import type { VideoTimeline } from '../utils/timeline';
import { readSidecar } from '../visuals/shot-editor';
import { escapeHtml } from '../visuals/motion/templates';
import type { MotionTheme } from '../visuals/motion/theme';

const execFileAsync = promisify(execFile);

/**
 * Thumbnails built from the video's own strongest frames: the LLM looks at candidate frames,
 * picks three, and writes short overlay text for each (complementing the title, never repeating
 * it); a browser template renders bold, high-contrast 1280x720 designs in the video's style.
 */

export const THUMB_WIDTH = 1280;
export const THUMB_HEIGHT = 720;
/** YouTube's upload limit for thumbnails. */
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATES = 12;
const VARIANTS = 3;

export interface ThumbnailPlan {
  /** Index into the candidate frames. */
  frame: number;
  text: string;
  /** The word (or words) shown in the accent colour. */
  highlight: string;
  /** Where the text goes: away from the subject. */
  side: 'left' | 'right';
}

export interface Thumbnail extends ThumbnailPlan {
  path: string;
  /** Where in the video the frame comes from. */
  atSec: number;
}

export interface FrameMoment {
  /** The file to take the frame from. */
  source: string;
  /** Time within that file. */
  sourceSec: number;
  /** Where it is in the finished video. */
  atSec: number;
}

/**
 * Moments worth a thumbnail: the middle of each clean footage or photo shot, taken from the
 * composed beat (no burned-in captions, no name captions or scan credits), spread across the
 * video. Without composed beats, evenly spaced frames of the finished video.
 */
export async function candidateMoments(timeline: VideoTimeline, finalVideoPath: string): Promise<FrameMoment[]> {
  const moments: FrameMoment[] = [];
  for (const beat of timeline.beats) {
    if (!beat.trackPath) continue;
    const sidecar = await readSidecar(beat.trackPath);
    for (const shot of sidecar?.shots ?? []) {
      const footage = shot.renderedType === 'archive' || shot.renderedType === 'stock';
      if (!footage || shot.note?.includes('caption:')) continue;
      const sourceSec = shot.startSec + shot.durationSec / 2;
      moments.push({ source: beat.trackPath, sourceSec, atSec: beat.sceneStartMs / 1000 + sourceSec });
    }
  }
  const total = timeline.totalMs / 1000;
  const pool: FrameMoment[] = moments.length >= VARIANTS
    ? moments
    : Array.from({ length: MAX_CANDIDATES }, (_, i) => {
        const at = total * (0.05 + (0.9 * i) / (MAX_CANDIDATES - 1));
        return { source: finalVideoPath, sourceSec: at, atSec: at };
      });
  if (pool.length <= MAX_CANDIDATES) return pool;
  // Evenly spaced picks keep the whole story represented
  return Array.from({ length: MAX_CANDIDATES }, (_, i) => pool[Math.round((i * (pool.length - 1)) / (MAX_CANDIDATES - 1))]);
}

/** Full-size frames for the designs, small copies for the LLM to look at. */
export async function extractFrames(moments: FrameMoment[], dir: string): Promise<Array<{ full: string; preview: string; atSec: number }>> {
  await fs.mkdir(dir, { recursive: true });
  const frames: Array<{ full: string; preview: string; atSec: number }> = [];
  for (const [i, m] of moments.entries()) {
    const full = path.join(dir, `frame_${i}.jpg`);
    const preview = path.join(dir, `frame_${i}_small.jpg`);
    try {
      await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', m.sourceSec.toFixed(3), '-i', m.source, '-frames:v', '1', '-q:v', '2', full]);
      await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-i', full, '-vf', 'scale=480:-2', '-q:v', '5', preview]);
      frames.push({ full, preview, atSec: m.atSec });
    } catch {
      // A frame past the end or unreadable is simply skipped
    }
  }
  return frames;
}

const PlanSchema = z.object({
  picks: z.array(
    z.object({
      frame: z.number(),
      text: z.string(),
      highlight: z.string(),
      subject_side: z.enum(['left', 'center', 'right']),
    }),
  ),
});

const cleanText = (t: string) => t.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

/** Keeps plans usable: distinct frames, 1-5 words, numbers the video states, highlight within the text. */
export function normalizePlans(
  picks: Array<{ frame: number; text: string; highlight: string; subject_side: 'left' | 'center' | 'right' }>,
  frameCount: number,
  ground: string,
): ThumbnailPlan[] {
  const pool = numbersIn(ground);
  const stated = (n: number) => pool.some((p) => Math.abs(p - n) <= Math.abs(p) * 0.005 + 1e-9);
  const plans: ThumbnailPlan[] = [];
  for (const p of picks) {
    const text = cleanText(p.text);
    const words = text.split(' ').filter(Boolean);
    if (p.frame < 0 || p.frame >= frameCount || plans.some((x) => x.frame === p.frame)) continue;
    if (words.length < 1 || words.length > 5) continue;
    const digits = numbersIn(text.replace(/\b[A-Z]+\b/g, (w) => (/^(THOUSAND|MILLION|BILLION|TRILLION)$/.test(w) ? w : ' ')));
    if (!digits.every(stated)) continue;
    const highlight = cleanText(p.highlight);
    plans.push({
      frame: p.frame,
      text,
      highlight: highlight && text.includes(highlight) ? highlight : words[words.length - 1],
      // Text goes opposite the subject; a centred subject leaves the left for text
      side: p.subject_side === 'left' ? 'right' : 'left',
    });
  }
  return plans.slice(0, VARIANTS);
}

/** Thumbnail picks from the LLM, which looks at every candidate frame. */
export async function planThumbnails(options: {
  frames: Array<{ preview: string }>;
  title: string;
  topic: string;
  narration: string;
  /** Thumbnail wishes from the creator's brief. */
  creatorIdeas?: string[];
  llm: LLMProvider;
  ctx: ProviderCallContext;
}): Promise<ThumbnailPlan[]> {
  const { frames, title, topic, narration, creatorIdeas = [], llm, ctx } = options;
  if (!llm.supportsVision) throw new Error(`${llm.id} cannot see images`);
  const images: LlmImage[] = await Promise.all(
    frames.map(async (f) => ({ mimeType: 'image/jpeg', data: (await fs.readFile(f.preview)).toString('base64') })),
  );
  const { data } = await llm.generateJson(
    {
      prompt: `You design YouTube thumbnails for a documentary channel.
Video: "${title}" (topic: ${topic})
What it covers: ${narration.slice(0, 2500)}
${creatorIdeas.length ? `The creator's thumbnail ideas (follow them where a frame fits; use their wording as overlay text when it fits the rules below):\n${creatorIdeas.map((t) => `- ${t}`).join('\n')}\n` : ''}
These ${frames.length} frames (numbered 0 to ${frames.length - 1} in order) come from the video. Pick the ${VARIANTS} that would make the strongest thumbnails: one clear subject, a face or striking scene, strong contrast, readable at small size, little text already in the frame. Prefer variety between the picks.
For each pick write overlay text: 2-4 punchy words that add intrigue the title doesn't already say (never repeat the title), only facts from the video. Choose 1-2 of those words to highlight. Say where the main subject sits in the frame (left, center, right) so the text can go on the other side.`,
      schema: PlanSchema,
      images,
      maxTokens: 1200,
    },
    ctx,
  );
  return normalizePlans(data.picks, frames.length, `${title} ${narration}`);
}

/** Without vision: evenly spread frames, words from the title. */
export function fallbackPlans(frameCount: number, title: string): ThumbnailPlan[] {
  const words = cleanText(title).split(' ').filter((w) => w.length > 2);
  const text = words.slice(0, 4).join(' ') || cleanText(title);
  return Array.from({ length: Math.min(VARIANTS, frameCount) }, (_, i) => ({
    frame: Math.round((i * (frameCount - 1)) / Math.max(1, VARIANTS - 1)),
    text,
    highlight: words[words.length > 1 ? 1 : 0] ?? text,
    side: i % 2 === 0 ? 'left' : 'right',
  }));
}

/** The text keeps to its side of the frame, clear of the subject. */
const TEXT_WIDTH = 640;
const LINE_CHARS = 10;

/** Short lines (about 10 characters, at most 3), so the text can be huge. */
export function thumbnailLines(words: string[]): string[][] {
  const lines: string[][] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && [...last, w].join(' ').length <= LINE_CHARS) last.push(w);
    else lines.push([w]);
  }
  while (lines.length > 3) {
    // Merge the shortest neighbouring pair
    let best = 0;
    for (let i = 1; i < lines.length - 1; i++) {
      if ([...lines[i], ...lines[i + 1]].join(' ').length < [...lines[best], ...lines[best + 1]].join(' ').length) best = i;
    }
    lines.splice(best, 2, [...lines[best], ...lines[best + 1]]);
  }
  return lines;
}

/** The design: the frame punched up, a gradient behind the text, huge outlined capitals. */
export function thumbnailHtml(theme: MotionTheme, plan: ThumbnailPlan, imageDataUrl: string, variant: number): string {
  const words = plan.text.split(' ');
  const highlight = new Set(plan.highlight.split(' '));
  const lines = thumbnailLines(words);
  const longest = Math.max(...lines.map((l) => l.join(' ').length));
  // As big as the text area allows (bold capitals run about 0.62 em wide)
  const fontSize = Math.min(170, Math.floor(TEXT_WIDTH / (Math.max(4, longest) * 0.62)));
  const side = plan.side;
  // Variant styles: accent-coloured words, an accent box behind them, or a bold accent bar
  const accentWord = (w: string) =>
    variant === 1
      ? `<span class="box">${escapeHtml(w)}</span>`
      : `<span class="hl">${escapeHtml(w)}</span>`;
  const html = lines
    .map((l) => l.map((w) => (highlight.has(w) ? accentWord(w) : escapeHtml(w))).join(' '))
    .join('<br>');
  // A solid outline from stacked shadows (renders reliably, unlike text-stroke on HTML text)
  const outline = (r: number) =>
    Array.from({ length: 16 }, (_, k) => {
      const a = (k / 16) * Math.PI * 2;
      return `${(Math.cos(a) * r).toFixed(1)}px ${(Math.sin(a) * r).toFixed(1)}px 0 #000`;
    }).join(',');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${THUMB_WIDTH}px;height:${THUMB_HEIGHT}px;overflow:hidden;background:#000}
.bg{position:absolute;inset:0;background:url(${imageDataUrl}) center/cover;filter:contrast(1.15) saturate(1.2) brightness(1.03)}
.shade{position:absolute;inset:0;background:linear-gradient(${side === 'left' ? '90deg' : '270deg'},rgba(0,0,0,.82) 0%,rgba(0,0,0,.55) 38%,rgba(0,0,0,0) 68%)}
.vig{position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 55%,rgba(0,0,0,.45) 100%)}
.text{position:absolute;top:50%;transform:translateY(-50%);${side}:56px;white-space:nowrap;text-align:${side};
font-family:"Segoe UI Black","Arial Black",Impact,sans-serif;font-size:${fontSize}px;line-height:1.0;color:#fff;letter-spacing:-1px;
text-shadow:${outline(Math.max(3, Math.round(fontSize / 30)))},0 10px 28px rgba(0,0,0,.65)}
.hl{color:${theme.accent}}
.box{background:${theme.accent};color:#111;text-shadow:none;padding:0 14px;border-radius:6px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.bar{position:absolute;${side}:56px;bottom:84px;width:220px;height:14px;background:${theme.accent};display:${variant === 2 ? 'block' : 'none'}}
</style></head><body><div class="bg"></div><div class="shade"></div><div class="vig"></div><div class="text">${html}</div><div class="bar"></div>
<script>
// Shrink until every line fits its side of the frame (fonts differ in width; measure, don't guess)
window.__fit=()=>{const t=document.querySelector('.text');let s=parseFloat(getComputedStyle(t).fontSize);
while((t.scrollWidth>${TEXT_WIDTH}||t.offsetHeight>${THUMB_HEIGHT - 140})&&s>40){s-=4;t.style.fontSize=s+'px'}};
</script></body></html>`;
}

/** Renders the designs to JPEG files under YouTube's 2 MB limit. */
export async function renderThumbnails(options: {
  plans: ThumbnailPlan[];
  frames: Array<{ full: string; atSec: number }>;
  theme: MotionTheme;
  outDir: string;
  browser?: Browser;
}): Promise<Thumbnail[]> {
  const { plans, frames, theme, outDir } = options;
  await fs.mkdir(outDir, { recursive: true });
  const browser = options.browser ?? (await chromium.launch({ headless: true }));
  const out: Thumbnail[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: THUMB_WIDTH, height: THUMB_HEIGHT } });
    for (const [i, plan] of plans.entries()) {
      const frame = frames[plan.frame];
      const dataUrl = `data:image/jpeg;base64,${(await fs.readFile(frame.full)).toString('base64')}`;
      await page.setContent(thumbnailHtml(theme, plan, dataUrl, i), { waitUntil: 'load' });
      await page.evaluate(async () => {
        await document.fonts?.ready;
        (window as unknown as { __fit: () => void }).__fit();
      });
      const target = path.join(outDir, `thumbnail_${i + 1}.jpg`);
      for (const quality of [92, 85, 75]) {
        const bytes = await page.screenshot({ type: 'jpeg', quality });
        if (bytes.length <= MAX_THUMB_BYTES || quality === 75) {
          await fs.writeFile(target, bytes);
          break;
        }
      }
      out.push({ ...plan, path: target, atSec: frame.atSec });
    }
    await page.close();
  } finally {
    if (!options.browser) await browser.close().catch(() => {});
  }
  return out;
}
