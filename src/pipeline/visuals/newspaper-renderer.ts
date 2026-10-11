import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import type { NewspaperSpec } from './types';
import { convertWebmToMp4 } from '../utils/ffmpeg';

const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: 'rgba(255, 235, 59, 0.82)',
  cyan: 'rgba(56, 189, 248, 0.78)',
  green: 'rgba(74, 222, 128, 0.78)',
  rose: 'rgba(251, 113, 133, 0.78)',
};

/**
 * Builds high-fidelity 1920x1080 HTML for an archival / broadsheet newspaper headline
 * with realistic paper textures, multi-column typography, and a sweep highlighter animation.
 */
export function buildNewspaperHtml(
  spec: NewspaperSpec,
  durationSeconds: number = 4,
): string {
  const outlet = (spec.outlet || 'THE DAILY CHRONICLE').toUpperCase();
  const date = (spec.date || 'OCTOBER 24, 1929').toUpperCase();
  const edition = (spec.edition || 'LATE CITY EDITION').toUpperCase();
  const headline = spec.headline || 'HISTORIC BREAKTHROUGH ANNOUNCED';
  const subheadline = spec.subheadline || 'Markets react swiftly as monumental shift unfolds worldwide';
  const snippet = spec.snippet || 'The developments began early this morning following weeks of intense speculation.';
  const highlightText = spec.highlightText;
  const highlightColor = HIGHLIGHT_COLORS[spec.highlightColor || 'yellow'] || HIGHLIGHT_COLORS.yellow;
  const style = spec.style || 'vintage';

  // If highlightText is provided, wrap first occurrence in <mark class="highlighter">
  let bodyTextHtml = snippet;
  if (highlightText && highlightText.trim().length > 0) {
    const escaped = highlightText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'i');
    if (regex.test(bodyTextHtml)) {
      bodyTextHtml = bodyTextHtml.replace(regex, '<mark class="highlighter">$1</mark>');
    } else {
      // If exact substring not found, highlight the first sentence
      bodyTextHtml = `<mark class="highlighter">${bodyTextHtml}</mark>`;
    }
  } else {
    // Default highlight first sentence for documentary focus
    const firstSentenceEnd = bodyTextHtml.indexOf('. ');
    if (firstSentenceEnd > 0) {
      bodyTextHtml = `<mark class="highlighter">${bodyTextHtml.slice(0, firstSentenceEnd + 1)}</mark>${bodyTextHtml.slice(firstSentenceEnd + 1)}`;
    } else {
      bodyTextHtml = `<mark class="highlighter">${bodyTextHtml}</mark>`;
    }
  }

  // Generate auxiliary filler text for background columns to give authentic 3-column newspaper look
  const fillerCol1 = `
    Special dispatches received late yesterday confirm unprecedented developments across key sectors.
    Witnesses and industry observers gathered in great numbers as official statements were read to the press.
    The immediate consensus indicates an irreversible turning point in modern institutional operations.
  `;
  const fillerCol3 = `
    Further inquiries remain underway with additional reports expected before nightfall.
    Representatives declined to elaborate further, citing pending regulatory compliance and archival verification.
    Financial markets reflected cautious optimism amidst rising public curiosity.
  `;

  const isDark = style === 'dark';
  const paperBg = isDark ? '#18181b' : '#f9f6ed';
  const paperText = isDark ? '#f4f4f5' : '#18181b';
  const paperBorder = isDark ? '#3f3f46' : '#27272a';
  const paperRule = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.14)';
  const ambientBg = isDark ? '#09090b' : '#0c0d11';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=1920, height=1080" />
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body, html {
      width: 1920px;
      height: 1080px;
      overflow: hidden;
      background: ${ambientBg};
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: Georgia, 'Playfair Display', 'Times New Roman', serif;
      perspective: 1400px;
    }

    /* Ambient desk lighting vignette */
    .desk-vignette {
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at 50% 45%, rgba(255,255,255,0.04) 0%, rgba(0,0,0,0.85) 85%);
      pointer-events: none;
      z-index: 10;
    }

    /* The Newspaper Sheet */
    .newspaper-scene {
      width: 1400px;
      height: 940px;
      transform-style: preserve-3d;
      transform: rotateX(4deg) rotateY(-2deg);
      animation: camera-push ${durationSeconds}s cubic-bezier(0.1, 0.7, 0.1, 1) forwards;
    }

    @keyframes camera-push {
      0% {
        transform: rotateX(4deg) rotateY(-2deg) scale(0.96) translateY(20px);
      }
      100% {
        transform: rotateX(2deg) rotateY(-1deg) scale(1.04) translateY(-10px);
      }
    }

    .paper-sheet {
      width: 100%;
      height: 100%;
      background: ${paperBg};
      color: ${paperText};
      padding: 55px 70px;
      position: relative;
      box-shadow:
        0 30px 70px rgba(0,0,0,0.7),
        0 10px 25px rgba(0,0,0,0.4),
        inset 0 0 100px rgba(0,0,0,0.06);
      border-radius: 3px;
      border: 1px solid rgba(0,0,0,0.12);
      display: flex;
      flex-direction: column;
    }

    /* Subtle paper texture overlay */
    .paper-texture {
      position: absolute;
      inset: 0;
      opacity: 0.12;
      background-image: radial-gradient(#000 0.8px, transparent 0.8px);
      background-size: 8px 8px;
      pointer-events: none;
    }

    /* Header Masthead */
    .masthead-container {
      text-align: center;
      margin-bottom: 18px;
    }

    .masthead-meta-top {
      display: flex;
      justify-content: space-between;
      font-size: 14px;
      letter-spacing: 2px;
      text-transform: uppercase;
      padding-bottom: 6px;
      border-bottom: 1px solid ${paperBorder};
      font-weight: 600;
      opacity: 0.8;
    }

    .masthead-title {
      font-size: 68px;
      font-weight: 900;
      letter-spacing: 5px;
      text-transform: uppercase;
      margin: 12px 0 10px 0;
      line-height: 1.05;
      border-bottom: 3px double ${paperBorder};
      padding-bottom: 10px;
    }

    .masthead-meta-bottom {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      padding-bottom: 14px;
      border-bottom: 1px solid ${paperBorder};
      font-weight: 600;
      opacity: 0.85;
    }

    /* Main Headline */
    .headline-section {
      text-align: center;
      margin: 16px 0 22px 0;
    }

    .headline-main {
      font-size: 54px;
      font-weight: 800;
      line-height: 1.15;
      letter-spacing: -0.5px;
      text-transform: uppercase;
      margin-bottom: 10px;
    }

    .headline-sub {
      font-size: 24px;
      font-style: italic;
      font-weight: 400;
      opacity: 0.85;
      line-height: 1.35;
      max-width: 90%;
      margin: 0 auto;
    }

    /* Multi-column article grid */
    .article-grid {
      display: grid;
      grid-template-columns: 1fr 1.6fr 1fr;
      gap: 32px;
      flex: 1;
      overflow: hidden;
      border-top: 1px solid ${paperRule};
      padding-top: 20px;
    }

    .column {
      font-size: 17px;
      line-height: 1.65;
      text-align: justify;
      position: relative;
    }

    .column:not(:last-child)::after {
      content: '';
      position: absolute;
      right: -16px;
      top: 0;
      bottom: 0;
      width: 1px;
      background: ${paperRule};
    }

    .center-column {
      font-size: 21px;
      line-height: 1.7;
    }

    .center-column::first-letter {
      float: left;
      font-size: 64px;
      line-height: 0.8;
      padding-right: 12px;
      padding-top: 6px;
      font-weight: 700;
    }

    /* Cinematic Yellow Highlighter Animation */
    mark.highlighter {
      background: transparent;
      color: inherit;
      position: relative;
      display: inline;
      padding: 0 4px;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }

    mark.highlighter::before {
      content: '';
      position: absolute;
      left: -4px;
      right: -4px;
      top: 8%;
      bottom: 4%;
      background: ${highlightColor};
      mix-blend-mode: multiply;
      border-radius: 3px;
      transform-origin: left center;
      animation: highlight-draw 1.6s cubic-bezier(0.2, 0.8, 0.25, 1) forwards;
      animation-delay: 0.35s;
      z-index: 1;
    }

    @keyframes highlight-draw {
      0% {
        transform: scaleX(0);
      }
      100% {
        transform: scaleX(1);
      }
    }
  </style>
</head>
<body>
  <div class="desk-vignette"></div>

  <div class="newspaper-scene">
    <div class="paper-sheet">
      <div class="paper-texture"></div>

      <!-- Masthead -->
      <div class="masthead-container">
        <div class="masthead-meta-top">
          <span>WEATHER: CLEAR &amp; COLD</span>
          <span>ESTABLISHED 1851</span>
          <span>PRICE: FIVE CENTS</span>
        </div>
        <div class="masthead-title">${outlet}</div>
        <div class="masthead-meta-bottom">
          <span>VOL. CLXXIV NO. 60,112</span>
          <span>${date}</span>
          <span>${edition}</span>
        </div>
      </div>

      <!-- Headline -->
      <div class="headline-section">
        <h1 class="headline-main">${headline}</h1>
        <div class="headline-sub">${subheadline}</div>
      </div>

      <!-- 3-Column Story -->
      <div class="article-grid">
        <div class="column">
          <p>${fillerCol1}</p>
        </div>
        <div class="column center-column">
          <p>${bodyTextHtml}</p>
        </div>
        <div class="column">
          <p>${fillerCol3}</p>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Renders the newspaper front page to a 1920x1080 PNG image using Playwright.
 */
export async function renderNewspaperToPng(
  spec: NewspaperSpec,
  outputPath: string,
  existingBrowser?: Browser,
): Promise<string> {
  const htmlContent = buildNewspaperHtml(spec, 4);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  let browser = existingBrowser;
  let shouldCloseBrowser = false;

  try {
    if (!browser) {
      browser = await chromium.launch({ headless: true });
      shouldCloseBrowser = true;
    }

    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });

    await page.setContent(htmlContent);
    // Allow highlighter animation to complete before snapping screenshot
    await page.waitForTimeout(2100);

    await page.screenshot({ path: outputPath, type: 'png' });
    await page.close();

    return outputPath;
  } catch (err) {
    throw new Error(
      `Failed rendering newspaper image to PNG: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (shouldCloseBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Renders an animated MP4 video clip (with highlighter sweep & smooth camera push-in)
 * using Playwright recordVideo and FFmpeg WebM-to-MP4 conversion.
 */
export async function renderNewspaperToMp4(
  spec: NewspaperSpec,
  outputPath: string,
  durationSeconds: number,
  tempDir: string,
  existingBrowser?: Browser,
): Promise<string> {
  const htmlContent = buildNewspaperHtml(spec, durationSeconds);

  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const htmlPath = path.join(tempDir, 'newspaper_anim.html');
  await fs.writeFile(htmlPath, htmlContent, 'utf-8');

  let browser = existingBrowser;
  let shouldCloseBrowser = false;

  try {
    if (!browser) {
      browser = await chromium.launch({ headless: true });
      shouldCloseBrowser = true;
    }

    const recDir = path.join(tempDir, 'rec');
    await fs.mkdir(recDir, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      recordVideo: {
        dir: recDir,
        size: { width: 1920, height: 1080 },
      },
    });

    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 25000 });

    const waitMs = Math.max(1000, durationSeconds * 1000);
    await page.waitForTimeout(waitMs);

    await page.close();
    await context.close();

    const recFiles = await fs.readdir(recDir);
    const webmFile = recFiles.find((f) => f.endsWith('.webm'));
    if (!webmFile) {
      throw new Error('Playwright did not output a recorded video file');
    }

    const rawWebmPath = path.join(recDir, webmFile);
    await convertWebmToMp4(rawWebmPath, outputPath, durationSeconds);

    return outputPath;
  } finally {
    if (shouldCloseBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}
