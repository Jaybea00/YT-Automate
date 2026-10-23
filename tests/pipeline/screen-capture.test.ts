import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { browserScrollTemplate, capturePage, domainOf, renderScreenRecording, urlFromQuery } from '../../src/pipeline/visuals/screen-capture.ts';
import { MOTION_RENDERERS } from '../../src/pipeline/visuals/motion-shots.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import type { ShotPlan } from '../../src/lib/script/generate-script.ts';

const article = '<p>' + 'A long article about payments and developer tools. '.repeat(40) + '</p>';
const PAGES: Record<string, { status?: number; html: string }> = {
  '/docs': {
    html: `<html><head><title>Docs</title></head><body style="margin:0;font:20px sans-serif">
<header style="height:120px;background:#635bff;color:#fff">Payments docs</header>${article}${article}
<div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;height:200px;background:#222;color:#fff">We use cookies <button onclick="document.getElementById('cookie-banner').remove()">Accept all</button></div>
<div class="ad-slot" style="height:300px;background:red">ADVERT</div>
<div id="takeover" style="position:fixed;inset:0;background:orange;z-index:9999">Sponsored takeover</div>
</body></html>`,
  },
  '/blocked': { html: '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>' },
  '/empty': { html: '<html><head><title>Empty</title></head><body></body></html>' },
  '/missing': { status: 404, html: 'Not found' },
};

describe('Screen recording shots', () => {
  let server: http.Server;
  let base: string;
  let browser: Browser;
  let dir: string;

  before(async () => {
    server = http.createServer((req, res) => {
      const page = PAGES[req.url ?? ''] ?? PAGES['/missing'];
      res.writeHead(page.status ?? 200, { 'Content-Type': 'text/html' });
      res.end(page.html);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-'));
  });
  after(async () => {
    await browser.close();
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a site straight from the shot when it names one', () => {
    assert.equal(urlFromQuery('stripe.com/docs'), 'https://stripe.com/docs');
    assert.equal(urlFromQuery('https://React.dev'), 'https://react.dev');
    assert.equal(urlFromQuery('the Stripe dashboard'), null);
    assert.equal(domainOf('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  });

  it('is a registered shot renderer (falling back to footage when it fails)', () => {
    assert.equal(MOTION_RENDERERS.screen_recording, renderScreenRecording);
  });

  it('captures a clean page: cookie banner accepted, ads and takeovers hidden, cached per URL', async () => {
    const cap = await capturePage(`${base}/docs`, dir, browser);
    assert.ok(cap.height >= 1080);
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    // The capture is an image of the page; check the overlays aren't in it by sampling pixels
    await page.setContent(`<img id="i" src="data:image/png;base64,${(await fs.readFile(cap.file)).toString('base64')}">`);
    const colours = await page.evaluate(async () => {
      const img = document.getElementById('i') as HTMLImageElement;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      // No named helpers in here: the test runner adds a __name() call the page does not have
      const [header, middle, bottom] = [
        [10, 60],
        [960, 540],
        [960, 1000],
      ].map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)));
      return { header, middle, bottom };
    });
    await page.close();
    assert.deepEqual(colours.header, [99, 91, 255], 'the page itself is there');
    assert.notDeepEqual(colours.middle, [255, 165, 0], 'the full-screen takeover is gone');
    assert.notDeepEqual(colours.bottom, [34, 34, 34], 'the cookie banner is gone');

    const again = await capturePage(`${base}/docs`, dir, browser);
    assert.equal(again.file, cap.file, 'reused from the cache');
  });

  it('refuses bot checks, empty pages and errors, so the shot falls back', async () => {
    await assert.rejects(capturePage(`${base}/blocked`, dir, browser), /blocks automated visits/);
    await assert.rejects(capturePage(`${base}/empty`, dir, browser), /empty page/);
    await assert.rejects(capturePage(`${base}/missing`, dir, browser), /HTTP 404/);
  });

  it('holds on the top of the page, then scrolls at most about one screen', () => {
    const html = browserScrollTemplate(themeForStyle('tech'), 'data:image/png;base64,x', 1920, 3600, 'stripe.com');
    assert.match(html, /const scroll=759\.6;/, '0.9 of the 844 px view');
    assert.match(html, />stripe\.com</);
    assert.match(html, /phase\(t,d\*0\.35/);
    assert.match(browserScrollTemplate(themeForStyle('tech'), 'x', 1920, 1080, 'a.com'), /const scroll=56\.0;/, 'a short page scrolls only what is left of it');
  });

  it('renders a shot from a named site, credited as a screenshot of it', async () => {
    const clip = path.join(dir, 'shot.mp4');
    const shot = { visual_type: 'screen_recording', visual_query: `${base}/docs`.replace('http://', ''), covers: 'the docs' } as ShotPlan;
    // urlFromQuery would make it https; point the renderer at the local server through a plain URL query
    const rendered = await renderScreenRecording(
      { ...shot, visual_query: 'localhost-docs' },
      { shot, startSec: 0, frames: 30 },
      clip,
      {
        beatIndex: 0,
        downloadDir: dir,
        theme: themeForStyle('tech'),
        browser,
        usedSources: new Set(),
        motionCounter: { next: 0 },
        llmProvider: {
          kind: 'llm',
          id: 'mock-url',
          generateText: async () => ({ text: '', usage: {} }),
          generateJson: async () => ({ data: { resolved: true, url: `${base}/docs` }, usage: {} }) as never,
        },
        llmCtx: { apiKey: 'k' },
      } as never,
    );
    assert.equal(rendered.renderedType, 'screen_recording');
    assert.equal(rendered.sourceUrl, `${base}/docs`);
    assert.match(rendered.attribution ?? '', /^Screenshot of 127\.0\.0\.1/);
    assert.ok((await fs.stat(clip)).size > 0);
  });
});
