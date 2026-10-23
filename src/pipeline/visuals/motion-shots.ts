import * as fs from 'node:fs/promises';
import { chromium } from 'playwright';
import type { ShotPlan, ShotType } from '@/lib/script/generate-script';
import { overlayCaption } from './clips';
import { normalizeLicenseType } from '../utils/media-upload';
import { renderMapClip } from './maps/map-clip';
import { documentZoomTemplate, findNewspaperScan, largerWikimediaImage } from './newspaper-scan';
import { diagramRevealTimes, diagramTemplate } from './motion/diagram';
import { fetchCommonsFile } from '../providers/stock/wikimedia';
import { resolvePlaces } from './maps/places';
import { FPS, FRAME_HEIGHT, FRAME_WIDTH, renderMotionClip } from './motion/frame-renderer';
import type { MotionTheme } from './motion/theme';
import {
  chartTemplate,
  comparisonTemplate,
  headlineTemplate,
  kineticTextTemplate,
  lowerThirdDocument,
  quoteTemplate,
  statTemplate,
  timelineTemplate,
  titleTemplate,
} from './motion/templates';
import type { RenderedShot, ShotSlot } from './shot-composer';
import type { ShotRenderContext, TypedShotRenderer } from './shot-renderers';
import { renderScreenRecording } from './screen-capture';
import { evidenceBoardTemplate, letterTemplate, pitchTemplate, raceBarsTemplate, scaleTemplate } from './motion/signature-templates';
import { moneyTemplate, specCardTemplate } from './motion/signature-templates-2';

/** The page for a graphic shot, or null when the shot lacks its spec. */
export function motionPageFor(shot: ShotPlan, theme: MotionTheme): string | null {
  switch (shot.visual_type) {
    case 'chart':
      return shot.chart ? chartTemplate(theme, shot.chart) : null;
    case 'stat':
      return shot.stat ? statTemplate(theme, shot.stat) : null;
    case 'quote':
      return shot.quote ? quoteTemplate(theme, shot.quote) : null;
    case 'newspaper':
      // A labelled recreation: the outlet and date as a caption, never a fake masthead
      return shot.newspaper ? headlineTemplate(theme, shot.newspaper) : null;
    case 'timeline':
      return shot.timeline?.events.length ? timelineTemplate(theme, shot.timeline.events) : null;
    case 'comparison':
      return shot.comparison
        ? comparisonTemplate(theme, shot.comparison.left, shot.comparison.right, shot.comparison.title)
        : null;
    case 'title':
      return shot.title_card ? titleTemplate(theme, shot.title_card) : null;
    case 'kinetic_text':
      return shot.kinetic ? kineticTextTemplate(theme, shot.kinetic.phrase, shot.kinetic.emphasis) : null;
    case 'pitch':
      return shot.pitch ? pitchTemplate(theme, shot.pitch) : null;
    case 'evidence_board':
      return shot.evidence ? evidenceBoardTemplate(theme, shot.evidence) : null;
    case 'letter':
      return shot.letter ? letterTemplate(theme, shot.letter) : null;
    case 'race_bars':
      return shot.race ? raceBarsTemplate(theme, shot.race) : null;
    case 'scale':
      return shot.scale ? scaleTemplate(theme, shot.scale) : null;
    case 'spec_card':
      return shot.spec ? specCardTemplate(theme, shot.spec) : null;
    case 'money':
      return shot.money ? moneyTemplate(theme, shot.money) : null;
    default:
      return null;
  }
}

const renderGraphic: TypedShotRenderer = async (shot, slot, clipPath, ctx) => {
  const html = motionPageFor(shot, ctx.theme);
  if (!html) throw new Error(`${shot.visual_type} shot has no spec`);
  await renderMotionClip({ html, durationSec: slot.frames / FPS, outputPath: clipPath, browser: ctx.browser });
  return {
    clipPath,
    renderedType: shot.visual_type,
    license: 'own_work',
    licenseSource: 'generated',
    note: shot.visual_type === 'newspaper' ? 'headline recreation' : undefined,
  };
};

const MAX_SCAN_BYTES = 15_000_000;

/**
 * A real front page when one can be found and verified (pushing in on the headline), otherwise
 * the labelled headline recreation.
 */
const renderNewspaper: TypedShotRenderer = async (shot, slot, clipPath, ctx) => {
  const paper = shot.newspaper;
  if (!paper) throw new Error('newspaper shot has no spec');
  const scan = await findNewspaperScan(paper, ctx.llmProvider, ctx.llmCtx).catch((err) => {
    console.warn(`[ShotRenderer] Beat ${ctx.beatIndex}: newspaper scan search failed (${err instanceof Error ? err.message.slice(0, 120) : err})`);
    return null;
  });
  if (scan) {
    try {
      const { candidate, box } = scan;
      const url = largerWikimediaImage(candidate);
      const res = await fetchCommonsFile(url, AbortSignal.timeout(60000));
      const bytes = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
      if (!bytes || bytes.length > MAX_SCAN_BYTES) throw new Error(`scan download failed (${res.status})`);
      const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
      // The rendition keeps the original's aspect ratio
      const origW = candidate.width || 1000;
      const origH = candidate.height || 1400;
      const thumbWidth = url.match(/[/-](\d+)px-[^/]+$/);
      const width = thumbWidth ? Number(thumbWidth[1]) : origW;
      const height = Math.round((origH * width) / origW);
      await renderMotionClip({
        html: documentZoomTemplate(ctx.theme, { imageUrl: `data:${mime};base64,${bytes.toString('base64')}`, width, height }, box, paper, 'Wikimedia Commons'),
        durationSec: slot.frames / FPS,
        outputPath: clipPath,
        browser: ctx.browser,
      });
      return {
        clipPath,
        renderedType: 'newspaper',
        sourceUrl: candidate.pageUrl || candidate.downloadUrl,
        license: normalizeLicenseType(candidate.license),
        licenseSource: 'wikimedia',
        attribution: candidate.attribution ?? null,
        note: 'archive scan',
      };
    } catch (err) {
      console.warn(`[ShotRenderer] Beat ${ctx.beatIndex}: scan render failed (${err instanceof Error ? err.message.slice(0, 120) : err}); using a recreation`);
    }
  }
  return renderGraphic(shot, slot, clipPath, ctx);
};

/** Animated map of the shot's places; fails (so the shot falls back to footage) if none resolve. */
const renderMap: TypedShotRenderer = async (shot, slot, clipPath, ctx) => {
  const names = shot.map?.places ?? [];
  const places = await resolvePlaces(names);
  if (places.length === 0) throw new Error(`Could not place any of: ${names.join(', ') || '(none)'}`);
  const dropped = names.length - places.length;
  await renderMapClip({
    places,
    mode: places.length >= 2 ? (shot.map?.mode ?? 'route') : 'locate',
    theme: ctx.theme,
    durationSec: slot.frames / FPS,
    outputPath: clipPath,
    browser: ctx.browser,
  });
  return {
    clipPath,
    renderedType: 'geo_map',
    // Natural Earth map data is public domain
    license: 'public_domain',
    licenseSource: 'natural_earth',
    note: dropped ? `${dropped} place(s) could not be placed` : undefined,
  };
};

/** Renderers for every motion-graphic shot type, matched to the video's theme. */
/** Diagrams reveal each step as the narration reaches it, so they need the shot's length and words. */
const renderDiagram: TypedShotRenderer = async (shot, slot, clipPath, ctx) => {
  if (!shot.diagram) throw new Error('diagram shot has no spec');
  const durationSec = slot.frames / FPS;
  const times = diagramRevealTimes(shot.diagram, shot.covers, durationSec);
  await renderMotionClip({ html: diagramTemplate(ctx.theme, shot.diagram, times), durationSec, outputPath: clipPath, browser: ctx.browser });
  return { clipPath, renderedType: 'diagram', license: 'own_work', licenseSource: 'generated' };
};

export const MOTION_RENDERERS: Partial<Record<ShotType, TypedShotRenderer>> = {
  diagram: renderDiagram,
  geo_map: renderMap,
  chart: renderGraphic,
  stat: renderGraphic,
  quote: renderGraphic,
  newspaper: renderNewspaper,
  timeline: renderGraphic,
  comparison: renderGraphic,
  title: renderGraphic,
  kinetic_text: renderGraphic,
  screen_recording: renderScreenRecording,
  pitch: renderGraphic,
  evidence_board: renderGraphic,
  letter: renderGraphic,
  race_bars: renderGraphic,
  scale: renderGraphic,
  spec_card: renderGraphic,
  money: renderGraphic,
};

/** Longer narration doesn't fit a type card legibly. */
const MAX_TEXT_CARD_WORDS = 22;

/**
 * The narration's own words as animated type: the last resort when no footage shows the shot,
 * since it always matches what is heard (an unrelated clip would mislead).
 */
export async function renderTextCard(
  shot: ShotPlan,
  slot: ShotSlot,
  clipPath: string,
  ctx: ShotRenderContext,
  note?: string,
): Promise<RenderedShot> {
  const words = shot.covers.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error('Shot has no narration to show');
  const phrase = words.length > MAX_TEXT_CARD_WORDS ? `${words.slice(0, MAX_TEXT_CARD_WORDS).join(' ')}…` : words.join(' ');
  await renderMotionClip({
    html: kineticTextTemplate(ctx.theme, phrase),
    durationSec: slot.frames / FPS,
    outputPath: clipPath,
    browser: ctx.browser,
  });
  return { clipPath, renderedType: 'kinetic_text', license: 'own_work', licenseSource: 'generated', note };
}

/**
 * Adds the shot's lower-third caption to a rendered footage clip, in place. A caption that
 * fails to render is dropped rather than failing the shot.
 */
export async function applyCaption(
  shot: ShotPlan,
  slot: ShotSlot,
  rendered: RenderedShot,
  ctx: Pick<ShotRenderContext, 'theme' | 'browser' | 'beatIndex'>,
): Promise<RenderedShot> {
  if (!shot.caption?.name) return rendered;
  const pngPath = rendered.clipPath.replace(/\.mp4$/, '.caption.png');
  const captioned = rendered.clipPath.replace(/\.mp4$/, '.captioned.mp4');
  const browser = ctx.browser ?? (await chromium.launch({ headless: true }));
  try {
    const page = await browser.newPage({ viewport: { width: FRAME_WIDTH, height: FRAME_HEIGHT } });
    try {
      await page.setContent(lowerThirdDocument(ctx.theme, shot.caption), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts?.ready);
      await page.screenshot({ path: pngPath, omitBackground: true });
    } finally {
      await page.close().catch(() => {});
    }
    await overlayCaption(rendered.clipPath, pngPath, slot.frames, captioned);
    await fs.rename(captioned, rendered.clipPath);
    return { ...rendered, note: [rendered.note, `caption: ${shot.caption.name}`].filter(Boolean).join('; ') };
  } catch (err) {
    console.warn(`[ShotRenderer] Beat ${ctx.beatIndex}: caption skipped (${err instanceof Error ? err.message.slice(0, 160) : err})`);
    await fs.unlink(captioned).catch(() => {});
    return rendered;
  } finally {
    await fs.unlink(pngPath).catch(() => {});
    if (!ctx.browser) await browser.close().catch(() => {});
  }
}
