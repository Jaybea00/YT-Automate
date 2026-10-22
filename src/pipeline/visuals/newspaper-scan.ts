import { z } from 'zod';
import { resizeCommonsThumb, searchWikimediaCommons } from '../providers/stock/wikimedia';
import type { LLMProvider, LlmImage, ProviderCallContext } from '../providers/types';
import { isUnusableLicense } from '../utils/media-upload';
import { motionDocument } from './motion/frame-renderer';
import { HELPERS, escapeHtml } from './motion/templates';
import type { MotionTheme } from './motion/theme';
import type { MediaCandidate } from './types';

/**
 * Real newspaper pages: finds a scan of the actual front page on Wikimedia Commons, has the LLM
 * confirm it is that outlet's page with that headline (and locate the headline), then renders a
 * "document zoom" that pushes in on it. When no verified scan exists, callers use the labelled
 * recreation instead.
 */

export interface PaperSpec {
  outlet: string;
  date: string;
  headline: string;
}

/** Headline position on the page, 0-1000 on each axis: [ymin, xmin, ymax, xmax]. */
export type HeadlineBox = [number, number, number, number];

export interface VerifiedScan {
  candidate: MediaCandidate;
  box: HeadlineBox;
}

const YEAR = /\b(1[6-9]\d{2}|20\d{2})\b/;

export function scanQueries(paper: PaperSpec): string[] {
  const year = paper.date.match(YEAR)?.[1] ?? '';
  const headline = paper.headline.replace(/["“”]/g, '');
  return [
    ...new Set(
      [
        `${paper.outlet} ${headline}`,
        `${paper.outlet} ${year} front page`,
        `${paper.outlet} ${year}`,
        headline,
        `${headline} newspaper`,
      ]
        .map((q) => q.replace(/\s+/g, ' ').trim())
        .filter((q) => q.length > 3),
    ),
  ];
}

const ScanCheckSchema = z.object({
  pages: z.array(
    z.object({
      index: z.number(),
      is_newspaper_page: z.boolean(),
      outlet_matches: z.boolean(),
      headline_visible: z.boolean(),
      headline_box: z.array(z.number()),
      reason: z.string(),
    }),
  ),
});

async function fetchImage(url: string, maxBytes = 4_000_000): Promise<LlmImage | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'YT-Automation/1.0 (newspaper scan check)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mimeType)) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length <= maxBytes ? { mimeType, data: bytes.toString('base64') } : null;
  } catch {
    return null;
  }
}

/**
 * A larger rendition of a Wikimedia thumbnail (the page is zoomed into, so resolution matters).
 * Thumbnail URLs carry their width ("/960px-Name.jpg", or "/lossy-page1-960px-Name.tif.jpg" for
 * TIFF scans), and Commons only serves its standard widths, so `width` should be one of them.
 * Originals no wider than that are returned as they are (TIFFs already as a JPEG rendering, see
 * the Wikimedia provider).
 */
export function largerWikimediaImage(candidate: MediaCandidate, width = 3840): string {
  const thumb = candidate.thumbnailUrl;
  if (/\/thumb\//.test(thumb) && /[/-]\d+px-[^/]+$/.test(thumb) && (candidate.width ?? 0) > width) {
    return resizeCommonsThumb(thumb, width);
  }
  return candidate.downloadUrl || thumb;
}

/** Finds and verifies a real scan of the front page, or returns null. */
export async function findNewspaperScan(
  paper: PaperSpec,
  llm: LLMProvider | undefined,
  ctx: ProviderCallContext | undefined,
): Promise<VerifiedScan | null> {
  // Without vision a scan can't be verified, and an unverified "real" page could be the wrong one
  if (!llm?.supportsVision || !ctx) return null;

  const candidates: MediaCandidate[] = [];
  for (const q of scanQueries(paper)) {
    const found = await searchWikimediaCommons(q, { limit: 5, minWidth: 500 }).catch(() => []);
    for (const c of found) {
      if (c.mediaType !== 'image' || isUnusableLicense(c.license)) continue;
      if (!candidates.some((x) => x.id === c.id || x.title === c.title)) candidates.push(c);
    }
    if (candidates.length >= 8) break;
  }
  if (candidates.length === 0) return null;

  const images = await Promise.all(candidates.map((c) => fetchImage(c.thumbnailUrl, 1_500_000)));
  const shown = candidates.map((c, i) => ({ c, img: images[i] })).filter((x) => x.img);
  if (shown.length === 0) return null;

  const { data } = await llm.generateJson(
    {
      prompt: `We need a real scan of a newspaper page: ${paper.outlet}, ${paper.date}, with the headline "${paper.headline}".
For each of the ${shown.length} images below (numbered 1 to ${shown.length} in order):
- is_newspaper_page: a photo or scan of an actual printed newspaper page (not a recreation, poster, or modern graphic)
- outlet_matches: the masthead or page is from ${paper.outlet}
- headline_visible: the headline "${paper.headline}" (or its exact wording) is printed and readable on it
- headline_box: where that headline is, as [ymin, xmin, ymax, xmax] scaled 0-1000; [0,0,0,0] if not visible`,
      schema: ScanCheckSchema,
      images: shown.map((x) => x.img!),
      maxTokens: 1200,
    },
    ctx,
  );

  for (const page of data.pages) {
    const match = shown[page.index - 1];
    const box = page.headline_box as HeadlineBox;
    const boxOk =
      box.length === 4 && box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000) && box[2] - box[0] > 10 && box[3] - box[1] > 10;
    if (match && page.is_newspaper_page && page.outlet_matches && page.headline_visible && boxOk) {
      return { candidate: match.c, box };
    }
  }
  return null;
}

/**
 * The document zoom: the whole page settles into frame, then the camera pushes in on the
 * headline and a highlighter sweeps under it. Credits the source as an archive scan.
 */
export function documentZoomTemplate(
  theme: MotionTheme,
  page: { imageUrl: string; width: number; height: number },
  box: HeadlineBox,
  paper: PaperSpec,
  credit: string,
): string {
  const data = JSON.stringify({ w: page.width, h: page.height, box });
  return motionDocument({
    css: `body{background:${theme.background}}
.bg{position:absolute;inset:0;background:${theme.backgroundOverlay}}
#page{position:absolute;left:0;top:0;transform-origin:0 0;box-shadow:0 30px 90px rgba(0,0,0,.55)}
#mark{position:absolute;left:0;top:0;transform-origin:0 0;background:${theme.accent};mix-blend-mode:multiply;opacity:.55}
.cap{position:absolute;left:80px;bottom:56px;padding:14px 26px;background:rgba(10,10,12,.78);color:#f6f3ec;font-family:${theme.headingFont};font-size:36px;font-style:italic}
.tag{display:block;margin-top:6px;font-style:normal;font-family:${theme.bodyFont};font-size:20px;letter-spacing:3px;text-transform:uppercase;color:#c9c4b8}`,
    body: `<div class="bg"></div><img id="page" src="${page.imageUrl}" width="${page.width}" height="${page.height}"><div id="mark"></div>
<div class="cap" id="cap">${escapeHtml(paper.outlet)}${paper.date ? `, ${escapeHtml(paper.date)}` : ''}<span class="tag">Archive scan · ${escapeHtml(credit)}</span></div>`,
    script: `${HELPERS}
const D=${data};
window.__ready=()=>document.getElementById('page').decode();
const W=1920,H=1080;
const s0=Math.min(1600/D.w,1000/D.h);
const bx=D.box[1]/1000*D.w,by=D.box[0]/1000*D.h,bw=(D.box[3]-D.box[1])/1000*D.w,bh=(D.box[2]-D.box[0])/1000*D.h;
// Close enough that the headline fills most of the width, never so close it turns to mush
const s1=Math.max(s0*1.4,Math.min(1450/bw,620/bh,s0*5));
const c0=[D.w/2,D.h/2],c1=[bx+bw/2,by+bh/2];
const pg=document.getElementById('page'),mk=document.getElementById('mark'),cap=document.getElementById('cap');
window.__frame=(t,d)=>{
  const z=easeInOut(phase(t,Math.min(0.9,d*0.22),Math.min(2.2,d*0.45)));
  const s=Math.exp(Math.log(s0)+(Math.log(s1)-Math.log(s0))*z);
  const cx=c0[0]+(c1[0]-c0[0])*z,cy=c0[1]+(c1[1]-c0[1])*z;
  // A slow drift keeps the frame alive after the push-in
  const drift=1+0.02*clamp((t-d*0.7)/(d*0.3));
  const S=s*drift,X=W/2-S*cx,Y=H/2-S*cy;
  const settle=ease(phase(t,0,0.6));
  pg.style.opacity=settle;pg.style.transform='translate('+X+'px,'+(Y+40*(1-settle))+'px) scale('+S+')';
  const m=ease(phase(t,Math.min(d*0.7,0.9+Math.min(2.2,d*0.45)),0.6));
  mk.style.transform='translate('+(X+S*bx)+'px,'+(Y+S*(by+bh*0.62))+'px) scale('+S+')';
  mk.style.width=(bw*m)+'px';mk.style.height=(bh*0.38)+'px';
  cap.style.opacity=ease(phase(t,0.4,0.5));
};`,
  });
}
