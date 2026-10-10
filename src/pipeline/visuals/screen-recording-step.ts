import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { LLMProvider, ProviderCallContext } from '../providers/types';
import { UrlResolutionSchema, type UrlResolution } from './types';
import { convertWebmToMp4 } from '../utils/ffmpeg';
import { callLlmJsonWithRetry } from '../providers/llm-retry';

export interface ScreenRecordingInput {
  visualQuery: string;
  text?: string;
  durationSeconds: number;
}

export interface ScreenRecordingUrlInput {
  visualQuery: string;
  text?: string;
  beatIndex?: number;
}

/**
 * Resolves visual_query to an official, authoritative, real domain URL using the bound LLM.
 * Returns { resolved: false } if not confidently resolvable.
 */
export async function resolveOfficialUrl(
  input: ScreenRecordingUrlInput,
  llmProvider: LLMProvider,
  ctx: ProviderCallContext,
): Promise<UrlResolution> {
  const beatTag = input.beatIndex != null ? `[Beat ${input.beatIndex}] ` : '';
  const system = `You are a strict URL resolution assistant for a video production pipeline.
Your task is to resolve a visual query into an official, real, authoritative website URL for screen recording.

HARD RULES:
1. ONLY resolve to real, well-known, official documentation or product domains (e.g., stripe.com/docs, react.dev, developer.mozilla.org, python.org, github.com, en.wikipedia.org, etc.).
2. NEVER guess, speculate, or invent paths on unfamiliar domains.
3. If you cannot confidently resolve a real, public, accessible URL, return { "resolved": false, "reason": "No confident official URL" }.
4. The URL must be fully qualified and start with https://.`;

  const prompt = `Visual Query: "${input.visualQuery}"\nContext Text: "${input.text || ''}"`;

  try {
    const result = await callLlmJsonWithRetry<UrlResolution>(
      llmProvider,
      {
        system,
        prompt,
        schema: UrlResolutionSchema,
      },
      ctx,
      2,
      `[ScreenRecording] ${beatTag}`.trim(),
    );

    const data = result.data;
    if (data.resolved && data.url) {
      try {
        const parsed = new URL(data.url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          console.warn(
            `[ScreenRecording] ${beatTag}LLM resolved URL "${data.url}" with invalid protocol.`,
          );
          return { resolved: false, reason: `Invalid protocol: ${data.url}` };
        }
        return { resolved: true, url: data.url };
      } catch {
        console.warn(
          `[ScreenRecording] ${beatTag}LLM resolved malformed URL "${data.url}".`,
        );
        return { resolved: false, reason: `Malformed URL: ${data.url}` };
      }
    }

    console.log(
      `[ScreenRecording] ${beatTag}LLM could not resolve confident official URL for query "${input.visualQuery}". Reason: "${data.reason || 'Unresolved'}"`,
    );
    return { resolved: false, reason: data.reason || 'Unresolved' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[ScreenRecording] ${beatTag}URL resolution error with LLM (provider: ${llmProvider.id}, model: ${ctx.model ?? 'default'}):`,
      err,
    );
    return {
      resolved: false,
      reason: `LLM call failed (${llmProvider.id}): ${errMsg}`,
    };
  }
}

/**
 * Executes screen recording using Playwright:
 * - Navigates to url in headless 1920x1080 browser
 * - Checks for 4xx/5xx HTTP status or bot detection/timeout
 * - Records video with slow scroll for durationSeconds
 * - Converts to MP4
 */
export async function recordUrlWithPlaywright(
  url: string,
  durationSeconds: number,
  outputMp4Path: string,
  tempDir: string,
  existingBrowser?: Browser,
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  let browser = existingBrowser;
  let shouldCloseBrowser = false;

  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(path.dirname(outputMp4Path), { recursive: true });

  try {
    if (!browser) {
      browser = await chromium.launch({ headless: true });
      shouldCloseBrowser = true;
    }

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      recordVideo: {
        dir: tempDir,
        size: { width: 1920, height: 1080 },
      },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
    } catch (navError) {
      await context.close().catch(() => {});
      const msg = navError instanceof Error ? navError.message : String(navError);
      return {
        success: false,
        error: `Navigation failed: ${msg}`,
      };
    }

    if (!response || response.status() >= 400) {
      await context.close().catch(() => {});
      return {
        success: false,
        error: `HTTP ${response?.status() ?? 'unknown'} error for URL "${url}"`,
      };
    }

    // Check for bot detection or access denied in title
    const title = (await page.title().catch(() => '')).toLowerCase();
    if (
      title.includes('access denied') ||
      title.includes('just a moment') ||
      title.includes('security check') ||
      title.includes('cloudflare')
    ) {
      await context.close().catch(() => {});
      return {
        success: false,
        error: `Automated access blocked by page protection: "${title}"`,
      };
    }

    // Smooth scroll for the duration
    const targetSeconds = Math.max(durationSeconds, 1);
    const scrollSteps = Math.max(1, Math.floor(targetSeconds));
    const stepDelayMs = Math.min(1000, (targetSeconds * 1000) / scrollSteps);

    for (let step = 0; step < scrollSteps; step++) {
      await page.evaluate(() => {
        window.scrollBy({ top: 120, behavior: 'smooth' });
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, stepDelayMs));
    }

    // Close context to finish video writing
    await context.close();
    const rawVideoPath = await page.video()?.path();

    if (!rawVideoPath) {
      return {
        success: false,
        error: 'Playwright did not produce a recorded video file',
      };
    }

    // Convert WebM to MP4 sized to durationSeconds
    await convertWebmToMp4(rawVideoPath, outputMp4Path, targetSeconds);

    // Clean up temporary WebM
    await fs.unlink(rawVideoPath).catch(() => {});

    return {
      success: true,
      outputPath: outputMp4Path,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Screen recording error: ${errorMsg}`,
    };
  } finally {
    if (shouldCloseBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}
