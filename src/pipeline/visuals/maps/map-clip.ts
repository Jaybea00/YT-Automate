import { chromium, type Browser } from 'playwright';
import { renderMotionClip } from '../motion/frame-renderer';
import type { MotionTheme } from '../motion/theme';
import { buildMapScene, type MapMode } from './map-scene';
import type { ResolvedPlace } from './places';

export interface RenderMapClipOptions {
  places: ResolvedPlace[];
  mode: MapMode;
  theme: MotionTheme;
  durationSec: number;
  outputPath: string;
  browser?: Browser;
}

/**
 * Renders an animated map clip. The static base map is drawn once as a normal page and captured
 * as an image (reliable even for detailed 1:10m coastlines), then the camera, highlights, arcs,
 * pins and labels are animated over it frame by frame.
 */
export async function renderMapClip(options: RenderMapClipOptions): Promise<string> {
  const { places, mode, theme, durationSec, outputPath } = options;
  const scene = buildMapScene({ places, mode, theme });
  const browser = options.browser ?? (await chromium.launch({ headless: true }));
  try {
    const context = await browser.newContext({
      viewport: { width: scene.baseWidth, height: scene.baseHeight },
      deviceScaleFactor: 1,
    });
    let baseJpeg: Buffer;
    try {
      const page = await context.newPage();
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:${scene.background}">${scene.baseSvg}</body></html>`,
        { waitUntil: 'load' },
      );
      baseJpeg = await page.screenshot({ type: 'jpeg', quality: 90 });
    } finally {
      await context.close().catch(() => {});
    }
    const html = scene.page(`data:image/jpeg;base64,${baseJpeg.toString('base64')}`);
    return await renderMotionClip({ html, durationSec, outputPath, browser });
  } finally {
    if (!options.browser) await browser.close().catch(() => {});
  }
}
