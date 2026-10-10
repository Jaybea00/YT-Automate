import type { LLMProvider, ProviderCallContext } from '../providers/types';
import { ChartSpecSchema, type ChartSpec } from './types';
import { renderChartToPng } from './chart-renderer';
import { callLlmJsonWithRetry } from '../providers/llm-retry';
import type { Browser } from 'playwright';

export interface ChartExtractionInput {
  text: string;
  visualQuery?: string;
  beatIndex?: number;
}

/**
 * Checks whether numbers in the series appear literally in the source text.
 * Safeguard against model hallucination / creative rounding.
 */
export function verifyNumbersInText(spec: ChartSpec, text: string): boolean {
  if (!spec.chartable || !spec.series || spec.series.length === 0) {
    return false;
  }

  // Normalize text for basic search (remove commas in 1,000 -> 1000)
  const normalizedText = text.replace(/,/g, '');

  for (const s of spec.series) {
    for (const val of s.values) {
      if (typeof val !== 'number' || Number.isNaN(val)) {
        return false;
      }
      const valStr = String(val);
      // Check if raw value or rounded integer appears in text
      const intStr = String(Math.floor(val));
      if (!normalizedText.includes(valStr) && !normalizedText.includes(intStr)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Calls the bound LLM provider to extract a chart spec with strict "no invented data" enforcement.
 */
export async function extractChartSpec(
  input: ChartExtractionInput,
  llmProvider: LLMProvider,
  ctx: ProviderCallContext,
): Promise<ChartSpec> {
  const beatTag = input.beatIndex != null ? `[Beat ${input.beatIndex}] ` : '';
  const system = `You are a strict data visualization analyst for a video pipeline.
Extract a structured chart specification from the provided video beat text.

CRITICAL HARD RULES (NO INVENTED DATA):
1. You may ONLY use numbers that literally and explicitly appear in the beat text.
2. NEVER estimate, interpolate, round creatively beyond what is stated, or invent a data point.
3. If there are no concrete numbers in the beat text, or not enough actual numeric content to make a genuine comparison/chart (e.g. only 0 or 1 number, or vague qualitative phrases like "significantly increased" without explicit numbers), you MUST set "chartable": false.
4. Do NOT use dates or calendar years as series values (e.g. 1995, 2024). Use them as labels instead.
5. If chartable is true, provide:
   - chartType: "bar", "line", "pie", or "doughnut"
   - title: clear, concise chart title
   - labels: category labels corresponding 1-to-1 to series values
   - series: array of { name?: string, values: number[] } where all values literally appeared in the text.`;

  const prompt = `Beat Text: "${input.text}"\nVisual Query: "${input.visualQuery || ''}"`;

  try {
    const result = await callLlmJsonWithRetry<ChartSpec>(
      llmProvider,
      {
        system,
        prompt,
        schema: ChartSpecSchema,
      },
      ctx,
      2,
      `[ChartStep] ${beatTag}`.trim(),
    );

    const spec = result.data;

    // Strict verification: all numbers must appear in text
    if (spec.chartable) {
      const verified = verifyNumbersInText(spec, input.text);
      if (!verified) {
        const seriesSummary =
          spec.series
            ?.map((s) => `${s.name || 'unnamed'}: [${s.values.join(', ')}]`)
            .join('; ') || 'empty';
        console.warn(
          `[ChartStep] ${beatTag}LLM suggested a chart, but series values do not literally appear in beat text "${input.text}". Extracted series: ${seriesSummary}. Rejecting chart to prevent invented data.`,
        );
        return {
          chartable: false,
          reason: `Series numbers do not literally appear in source text: ${seriesSummary}`,
        };
      }
    } else {
      console.log(
        `[ChartStep] ${beatTag}LLM determined content is not chartable. Reason: "${spec.reason || 'No numeric comparison found'}"`,
      );
    }

    return spec;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[ChartStep] ${beatTag}Error extracting chart spec from LLM (provider: ${llmProvider.id}, model: ${ctx.model ?? 'default'}):`,
      err,
    );
    return {
      chartable: false,
      reason: `LLM call failed (${llmProvider.id}): ${errMsg}`,
    };
  }
}

/**
 * Handles chart generation: extracts spec, verifies, and renders to 1920x1080 PNG.
 * Returns null if unchartable so caller can fall back to stock.
 */
export async function executeChartStep(
  input: ChartExtractionInput,
  outputPath: string,
  llmProvider: LLMProvider,
  ctx: ProviderCallContext,
  browser?: Browser,
): Promise<{ success: boolean; spec?: ChartSpec; outputPath?: string; reason?: string }> {
  const beatTag = input.beatIndex != null ? `[Beat ${input.beatIndex}] ` : '';
  const spec = await extractChartSpec(input, llmProvider, ctx);

  if (!spec.chartable || !spec.series || spec.series.length === 0) {
    return {
      success: false,
      spec,
      reason: spec.reason || 'Insufficient numeric content in text to chart.',
    };
  }

  try {
    await renderChartToPng(spec, outputPath, browser);
    return {
      success: true,
      spec,
      outputPath,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[ChartStep] ${beatTag}Failed rendering chart PNG to "${outputPath}":`,
      err,
    );
    return {
      success: false,
      spec,
      reason: `Failed rendering chart PNG: ${errMsg}`,
    };
  }
}
