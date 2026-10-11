import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  extractNewspaperHeuristic,
  executeNewspaperStep,
} from '../../src/pipeline/visuals/newspaper-step';
import {
  buildNewspaperHtml,
  renderNewspaperToPng,
} from '../../src/pipeline/visuals/newspaper-renderer';
import { classifyVisualIntent } from '../../src/pipeline/visuals/intent-classifier';

test('Newspaper & Document Headline Generator Tests', async (t) => {
  const tempDir = path.join(process.cwd(), 'storage', 'test_newspaper');
  await fs.mkdir(tempDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('1. classifyVisualIntent detects newspaper keywords and explicit type', () => {
    const explicit = classifyVisualIntent('Some text', 'Some query', 'newspaper');
    assert.equal(explicit.intent, 'newspaper');
    assert.equal(explicit.confidence, 1.0);

    const fromText = classifyVisualIntent('The morning headline shocked investors on Wall Street.');
    assert.equal(fromText.intent, 'newspaper');

    const fromQuery = classifyVisualIntent('The economy collapsed.', 'vintage newspaper with front page headline');
    assert.equal(fromQuery.intent, 'newspaper');
  });

  await t.test('2. extractNewspaperHeuristic extracts outlet, quote, date, and headline', () => {
    const text = 'On October 29, 1929, The Wall Street Journal reported that "billions in wealth evaporated in hours" across the financial district.';
    const spec = extractNewspaperHeuristic(text);

    assert.equal(spec.outlet, 'THE WALL STREET JOURNAL');
    assert.ok(spec.date?.includes('OCTOBER 29, 1929'));
    assert.equal(spec.highlightText, 'billions in wealth evaporated in hours');
    assert.ok(spec.headline.length > 0);
    assert.equal(spec.edition, 'LATE CITY EDITION');
  });

  await t.test('3. buildNewspaperHtml generates valid 1920x1080 HTML with highlighter animation', () => {
    const html = buildNewspaperHtml({
      outlet: 'THE WASHINGTON POST',
      date: 'JULY 21, 1969',
      edition: 'LATE SPECIAL',
      headline: 'MEN WALK ON MOON',
      subheadline: 'Astronauts Land on Plain; Collect Rocks and Plant Flag',
      snippet: 'Two Americans stepped onto the lunar surface today in the supreme triumph of human exploration.',
      highlightText: 'Two Americans stepped onto the lunar surface',
      highlightColor: 'yellow',
      style: 'vintage',
    });

    assert.ok(html.includes('THE WASHINGTON POST'));
    assert.ok(html.includes('MEN WALK ON MOON'));
    assert.ok(html.includes('<mark class="highlighter">'));
    assert.ok(html.includes('highlight-draw'));
    assert.ok(html.includes('1920px'));
    assert.ok(html.includes('1080px'));
  });

  await t.test('4. renderNewspaperToPng renders high-resolution PNG using Playwright', async () => {
    const pngOutput = path.join(tempDir, 'newspaper_test.png');
    const spec = {
      outlet: 'THE FINANCIAL TIMES',
      date: 'SEPTEMBER 15, 2008',
      headline: 'LEHMAN FILES FOR BANKRUPTCY',
      subheadline: 'Wall Street giant collapses triggering global shockwaves',
      snippet: 'The historic firm filed for Chapter 11 protection following a desperate weekend of negotiations.',
      highlightText: 'The historic firm filed for Chapter 11 protection',
      highlightColor: 'yellow' as const,
      style: 'vintage' as const,
    };

    const resultPath = await renderNewspaperToPng(spec, pngOutput);
    assert.equal(resultPath, pngOutput);

    const stat = await fs.stat(pngOutput);
    assert.ok(stat.isFile());
    assert.ok(stat.size > 10000, `Expected image file > 10KB, got ${stat.size} bytes`);
  });

  await t.test('5. executeNewspaperStep completes end-to-end visual step (PNG mode)', async () => {
    const outputPng = path.join(tempDir, 'step_newspaper.png');
    const result = await executeNewspaperStep({
      text: 'The New York Times published a scathing editorial declaring that "the era of unchecked monopoly has ended."',
      visualQuery: 'vintage newspaper headline',
      durationSeconds: 3,
      outputMp4Path: outputPng,
      tempDir: path.join(tempDir, 'step_temp'),
      asVideo: false,
    });

    assert.equal(result.success, true);
    assert.ok(result.outputPath);
    assert.equal(result.spec?.outlet, 'THE NEW YORK TIMES');
    assert.equal(result.spec?.highlightText, 'the era of unchecked monopoly has ended.');

    const stat = await fs.stat(result.outputPath!);
    assert.ok(stat.isFile());
    assert.ok(stat.size > 10000);
  });
});
