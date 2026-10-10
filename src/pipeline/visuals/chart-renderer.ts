import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { ChartSpec } from './types';

const PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#8b5cf6', // purple
  '#06b6d4', // cyan
  '#f43f5e', // rose
  '#ec4899', // pink
  '#84cc16', // lime
];

/**
 * Builds a clean, high-contrast, 1920x1080 SVG chart markup
 */
export function buildChartSvg(spec: ChartSpec): string {
  const width = 1920;
  const height = 1080;
  const title = spec.title || 'Data Overview';
  const labels = spec.labels || [];
  const primarySeries = spec.series?.[0] || { values: [] };
  const values = primarySeries.values || [];

  const chartType = spec.chartType || 'bar';

  // Area boundaries
  const marginTop = 180;
  const marginBottom = 140;
  const marginLeft = 200;
  const marginRight = 200;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  let bodySvg = '';

  if (chartType === 'bar' || chartType === 'line') {
    const maxVal = Math.max(...values, 1);
    const minVal = Math.min(...values, 0);
    const range = maxVal - minVal || 1;

    // Grid lines (4 steps)
    const steps = 4;
    let gridSvg = '';
    for (let i = 0; i <= steps; i++) {
      const y = marginTop + (plotHeight / steps) * i;
      const val = Math.round(maxVal - (range / steps) * i);
      gridSvg += `
        <line x1="${marginLeft}" y1="${y}" x2="${marginLeft + plotWidth}" y2="${y}" stroke="#27272a" stroke-width="2" stroke-dasharray="6 6" />
        <text x="${marginLeft - 25}" y="${y + 8}" fill="#71717a" font-size="24" font-family="system-ui, sans-serif" text-anchor="end">${val.toLocaleString()}</text>
      `;
    }

    if (chartType === 'bar') {
      const n = Math.max(values.length, 1);
      const slotWidth = plotWidth / n;
      const barWidth = Math.min(140, slotWidth * 0.6);

      let barsSvg = '';
      for (let i = 0; i < values.length; i++) {
        const val = values[i];
        const barH = ((val - minVal) / range) * plotHeight;
        const x = marginLeft + i * slotWidth + (slotWidth - barWidth) / 2;
        const y = marginTop + plotHeight - barH;
        const color = PALETTE[i % PALETTE.length];
        const label = labels[i] || `Item ${i + 1}`;

        barsSvg += `
          <rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="12" fill="${color}" filter="drop-shadow(0 10px 15px rgba(0,0,0,0.5))" />
          <text x="${x + barWidth / 2}" y="${y - 18}" fill="#ffffff" font-size="34" font-weight="bold" font-family="system-ui, sans-serif" text-anchor="middle">${val.toLocaleString()}</text>
          <text x="${x + barWidth / 2}" y="${marginTop + plotHeight + 50}" fill="#a1a1aa" font-size="28" font-family="system-ui, sans-serif" text-anchor="middle">${label}</text>
        `;
      }
      bodySvg = gridSvg + barsSvg;
    } else {
      // Line chart
      const n = Math.max(values.length, 1);
      const slotWidth = plotWidth / (n > 1 ? n - 1 : 1);
      const points: Array<{ x: number; y: number; val: number; label: string }> = [];

      for (let i = 0; i < values.length; i++) {
        const val = values[i];
        const x = n > 1 ? marginLeft + i * slotWidth : marginLeft + plotWidth / 2;
        const y = marginTop + plotHeight - ((val - minVal) / range) * plotHeight;
        points.push({ x, y, val, label: labels[i] || `P${i + 1}` });
      }

      let linePath = `M ${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        linePath += ` L ${points[i].x} ${points[i].y}`;
      }

      let pointsSvg = '';
      for (const p of points) {
        pointsSvg += `
          <circle cx="${p.x}" cy="${p.y}" r="12" fill="#3b82f6" stroke="#ffffff" stroke-width="4" />
          <text x="${p.x}" y="${p.y - 25}" fill="#ffffff" font-size="34" font-weight="bold" font-family="system-ui, sans-serif" text-anchor="middle">${p.val.toLocaleString()}</text>
          <text x="${p.x}" y="${marginTop + plotHeight + 50}" fill="#a1a1aa" font-size="28" font-family="system-ui, sans-serif" text-anchor="middle">${p.label}</text>
        `;
      }

      bodySvg = `
        ${gridSvg}
        <path d="${linePath}" fill="none" stroke="#3b82f6" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
        ${pointsSvg}
      `;
    }
  } else {
    // Pie / Doughnut
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const centerX = width / 2;
    const centerY = marginTop + plotHeight / 2;
    const radius = 260;
    const innerRadius = chartType === 'doughnut' ? 140 : 0;

    let cumulativeAngle = -Math.PI / 2;
    let slicesSvg = '';
    let legendSvg = '';

    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      const sliceAngle = (val / total) * 2 * Math.PI;
      const startAngle = cumulativeAngle;
      const endAngle = cumulativeAngle + sliceAngle;
      cumulativeAngle += sliceAngle;

      const x1 = centerX + radius * Math.cos(startAngle);
      const y1 = centerY + radius * Math.sin(startAngle);
      const x2 = centerX + radius * Math.cos(endAngle);
      const y2 = centerY + radius * Math.sin(endAngle);

      const largeArc = sliceAngle > Math.PI ? 1 : 0;
      const color = PALETTE[i % PALETTE.length];
      const label = labels[i] || `Slice ${i + 1}`;
      const pct = Math.round((val / total) * 100);

      let pathD = '';
      if (innerRadius > 0) {
        const ix1 = centerX + innerRadius * Math.cos(endAngle);
        const iy1 = centerY + innerRadius * Math.sin(endAngle);
        const ix2 = centerX + innerRadius * Math.cos(startAngle);
        const iy2 = centerY + innerRadius * Math.sin(startAngle);
        pathD = `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix2} ${iy2} Z`;
      } else {
        pathD = `M ${centerX} ${centerY} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
      }

      slicesSvg += `<path d="${pathD}" fill="${color}" stroke="#09090b" stroke-width="4" />`;

      const legendY = marginTop + 40 + i * 50;
      legendSvg += `
        <rect x="${width - 380}" y="${legendY}" width="24" height="24" rx="4" fill="${color}" />
        <text x="${width - 340}" y="${legendY + 20}" fill="#f4f4f5" font-size="24" font-family="system-ui, sans-serif">${label}: ${val.toLocaleString()} (${pct}%)</text>
      `;
    }

    bodySvg = slicesSvg + legendSvg;
  }

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bgGrad" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stop-color="#18181b" />
          <stop offset="100%" stop-color="#09090b" />
        </radialGradient>
      </defs>
      <!-- Background -->
      <rect width="${width}" height="${height}" fill="url(#bgGrad)" />
      
      <!-- Border card -->
      <rect x="60" y="50" width="${width - 120}" height="${height - 100}" rx="32" fill="#09090b" fill-opacity="0.4" stroke="#27272a" stroke-width="3" />

      <!-- Title -->
      <text x="${width / 2}" y="125" fill="#ffffff" font-size="52" font-weight="800" font-family="system-ui, sans-serif" text-anchor="middle" letter-spacing="-0.02em">
        ${title}
      </text>

      <!-- Chart Content -->
      ${bodySvg}
    </svg>
  `.trim();
}

/**
 * Renders a ChartSpec to a 1920x1080 PNG image using Playwright headless browser
 */
export async function renderChartToPng(
  spec: ChartSpec,
  outputPath: string,
  existingBrowser?: Browser,
): Promise<string> {
  const svgContent = buildChartSvg(spec);
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body, html { width: 1920px; height: 1080px; overflow: hidden; background: #09090b; }
          svg { width: 1920px; height: 1080px; display: block; }
        </style>
      </head>
      <body>
        ${svgContent}
      </body>
    </html>
  `;

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

    await page.setContent(html);
    await page.screenshot({ path: outputPath, type: 'png' });
    await page.close();

    return outputPath;
  } catch (err) {
    // If headless browser fails, write the SVG file as fallback
    const svgPath = outputPath.replace(/\.png$/, '.svg');
    await fs.writeFile(svgPath, svgContent, 'utf-8');
    throw new Error(
      `Failed rendering chart screenshot to PNG: ${err instanceof Error ? err.message : String(err)}. Saved SVG fallback at ${svgPath}`,
    );
  } finally {
    if (shouldCloseBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}
