import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { computeShotTimeline, composeBeatTrack, summarizeLicenses } from '../../src/pipeline/visuals/shot-composer.ts';
import { makeColorClip, makeFootageClip, kenBurnsFilter } from '../../src/pipeline/visuals/clips.ts';
import { renderMotionClip, motionDocument } from '../../src/pipeline/visuals/motion/frame-renderer.ts';
import { chooseVideoStart, createShotRenderer } from '../../src/pipeline/visuals/shot-renderers.ts';
import { MOTION_RENDERERS, applyCaption, motionPageFor } from '../../src/pipeline/visuals/motion-shots.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { chooseArchiveFile } from '../../src/pipeline/providers/stock/archive-org.ts';
import { DownloadTooLargeError, downloadToFile } from '../../src/pipeline/utils/download.ts';
import type { ShotPlan } from '../../src/lib/script/generate-script.ts';

const execFileAsync = promisify(execFile);
const realFetch = globalThis.fetch;

async function frameCount(file: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', file]);
  const [width, height, frames] = stdout.trim().split(',').map(Number);
  assert.deepEqual([width, height], [1920, 1080], 'clips are 1080p');
  return frames;
}

const shot = (word_start: number, word_count: number, visual_type: ShotPlan['visual_type'] = 'stock'): ShotPlan => ({
  visual_type,
  visual_query: 'q',
  covers: 'x',
  word_start,
  word_count,
});

describe('Shot timeline', () => {
  it('cuts each shot on the start of its first word, frame-exact, ending with the audio', () => {
    const words = Array.from({ length: 12 }, (_, i) => ({ word: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const slots = computeShotTimeline([shot(0, 4), shot(4, 5), shot(9, 3)], words, 6.2);
    assert.deepEqual(slots.map((s) => [s.startSec, s.frames]), [[0, 60], [2, 75], [4.5, 51]]);
    assert.equal(slots.reduce((n, s) => n + s.frames, 0), Math.round(6.2 * 30));
  });

  it('falls back to word-count proportions without timings, and never gives a shot zero frames', () => {
    const slots = computeShotTimeline([shot(0, 5), shot(5, 5)], null, 4);
    assert.deepEqual(slots.map((s) => s.frames), [60, 60]);
    const squeezed = computeShotTimeline([shot(0, 1), shot(1, 1), shot(2, 1)], null, 0.04);
    assert.ok(squeezed.every((s) => s.frames >= 1));
  });
});

describe('Shot sources', () => {
  it('starts long archive films past their opening, short clips at zero', () => {
    assert.equal(chooseVideoStart(8, 4), 0);
    assert.equal(chooseVideoStart(600, 4), 120);
    assert.equal(chooseVideoStart(14, 4), 2.8);
  });

  it('picks a small web derivative from an archive.org item, never a file over the cap', () => {
    const chosen = chooseArchiveFile([
      { name: 'reel_original.mp4', size: String(700 * 1048576) },
      { name: 'reel_512kb.mp4', size: String(40 * 1048576), format: '512Kb MPEG4' },
      { name: 'reel.thumbs/reel_000001.jpg', size: '9000' },
    ]);
    assert.equal(chosen?.name, 'reel_512kb.mp4');
    assert.equal(chooseArchiveFile([{ name: 'huge.mp4', size: String(500 * 1048576) }, { name: 'poster.jpg', size: '400000' }])?.name, 'poster.jpg');
  });

  it('keeps the most demanding license and every attribution for a composite beat', () => {
    const summary = summarizeLicenses([
      { clipPath: 'a', renderedType: 'stock', license: 'royalty_free', attribution: 'Pixabay user', sourceUrl: 'https://pixabay.com/1' },
      { clipPath: 'b', renderedType: 'archive', license: 'cc_by_sa', attribution: 'Photo: J. Smith, CC BY-SA', sourceUrl: 'https://commons.wikimedia.org/x' },
      { clipPath: 'c', renderedType: 'chart', license: null },
    ]);
    assert.equal(summary.license, 'cc_by_sa');
    assert.equal(summary.attribution, 'Pixabay user · Photo: J. Smith, CC BY-SA');
    assert.equal(summary.sources.length, 2);
  });
});

describe('Download limits', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-'));
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('refuses a file whose declared size is over the cap', async () => {
    globalThis.fetch = (async () => new Response('x', { headers: { 'content-length': String(200 * 1048576) } })) as typeof fetch;
    await assert.rejects(downloadToFile('https://x/big.mp4', path.join(dir, 'big.mp4')), DownloadTooLargeError);
  });

  it('stops streaming once a file without a declared size passes the cap, and cleans up', async () => {
    globalThis.fetch = (async () => new Response(new Uint8Array(4096))) as typeof fetch;
    const target = path.join(dir, 'stream.bin');
    await assert.rejects(downloadToFile('https://x/s', target, { maxBytes: 1000 }), DownloadTooLargeError);
    await assert.rejects(fs.stat(target), 'partial file removed');
    await downloadToFile('https://x/s', target, { maxBytes: 10000 });
    assert.equal((await fs.stat(target)).size, 4096);
  });
});

describe('Rendering clips (ffmpeg + browser)', () => {
  let dir: string;
  let image: string;
  let video: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clips-'));
    image = path.join(dir, 'portrait.jpg');
    video = path.join(dir, 'short.mp4');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280', '-frames:v', '1', image]);
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25', '-t', '1', '-pix_fmt', 'yuv420p', video]);
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('renders a photo with a camera move to an exact frame count', async () => {
    assert.match(kenBurnsFilter('pan_left', 90), /d=90:s=1920x1080:fps=30/);
    const out = await makeFootageClip({ inputPath: image, isVideo: false, frames: 45, outputPath: path.join(dir, 'still.mp4'), motion: 'pan_left' });
    assert.equal(await frameCount(out), 45);
  });

  it('renders a too-short video by holding its last frame', async () => {
    const out = await makeFootageClip({ inputPath: video, isVideo: true, frames: 60, outputPath: path.join(dir, 'held.mp4') });
    assert.equal(await frameCount(out), 60);
  });

  it('renders motion graphics frame by frame', async () => {
    const html = motionDocument({
      css: 'body{background:#123}',
      body: '<div id="n" style="color:#fff;font-size:200px">0</div>',
      script: 'window.__frame=(t)=>{document.getElementById("n").textContent=Math.round(t*30)}',
    });
    const out = await renderMotionClip({ html, durationSec: 0.5, outputPath: path.join(dir, 'motion.mp4') });
    assert.equal(await frameCount(out), 15);
  });

  it('composes a beat exactly as long as its audio, keeping timing when a shot fails', async () => {
    const composed = await composeBeatTrack({
      beatIndex: 3,
      shots: [shot(0, 4), shot(4, 4, 'chart'), shot(8, 4)],
      words: null,
      audioDurationSec: 2.5,
      outputDir: dir,
      renderShot: async (slot, clipPath) => {
        if (slot.shot.visual_type === 'chart') throw new Error('renderer exploded');
        await makeColorClip('#334455', slot.frames, clipPath);
        return { clipPath, renderedType: 'stock', license: 'royalty_free' };
      },
    });

    assert.equal(await frameCount(composed.trackPath), 75);
    assert.deepEqual(composed.shots.map((s) => s.renderedType), ['stock', 'color', 'stock']);
    assert.match(composed.shots[1].error ?? '', /renderer exploded/);
    const sidecar = JSON.parse(await fs.readFile(`${composed.trackPath}.shots.json`, 'utf-8'));
    assert.equal(sidecar.shots.length, 3);
  });

  it('renders a graphic shot through the shot renderer at its exact length', async () => {
    const render = createShotRenderer(
      { beatIndex: 0, downloadDir: dir, theme: themeForStyle('vox_explainer'), usedSources: new Set(), motionCounter: { next: 0 } },
      MOTION_RENDERERS,
    );
    const stat: ShotPlan = { ...shot(0, 5, 'stat'), stat: { value: 25, suffix: '%', label: 'unemployed by 1933' } };
    const result = await render({ shot: stat, startSec: 0, frames: 20 }, path.join(dir, 'stat.mp4'));
    assert.equal(result.renderedType, 'stat');
    assert.equal(result.license, 'own_work');
    assert.equal(await frameCount(result.clipPath), 20);
  });

  it('renders a map shot offline, and falls back to footage when no place can be placed', async () => {
    const render = createShotRenderer(
      { beatIndex: 0, downloadDir: dir, theme: themeForStyle('story_driven'), usedSources: new Set(), motionCounter: { next: 0 } },
      MOTION_RENDERERS,
    );
    const map: ShotPlan = { ...shot(0, 5, 'geo_map'), map: { places: ['London', 'Paris'], mode: 'route' } };
    const result = await render({ shot: map, startSec: 0, frames: 15 }, path.join(dir, 'map.mp4'));
    assert.equal(result.renderedType, 'geo_map');
    assert.equal(result.license, 'public_domain');
    assert.equal(await frameCount(result.clipPath), 15);
  });

  it('overlays a lower-third caption without changing the clip length', async () => {
    const clipPath = await makeColorClip('#445566', 45, path.join(dir, 'captioned.mp4'));
    const captioned: ShotPlan = { ...shot(0, 5, 'archive'), caption: { name: 'Herbert Hoover', detail: 'U.S. President' } };
    const result = await applyCaption(captioned, { shot: captioned, startSec: 0, frames: 45 }, { clipPath, renderedType: 'archive' }, {
      beatIndex: 0,
      theme: themeForStyle('story_driven'),
    });
    assert.match(result.note ?? '', /caption: Herbert Hoover/);
    assert.equal(await frameCount(clipPath), 45);
  });
});

describe('Motion graphic pages', () => {
  const theme = themeForStyle('tech');
  it('builds a page for every graphic spec, escaping text', () => {
    const specs: ShotPlan[] = [
      { ...shot(0, 5, 'chart'), chart: { chart_type: 'bar', title: 'A', labels: ['x', 'y'], values: [1, 2] } },
      { ...shot(0, 5, 'quote'), quote: { text: '<b>bold</b> words here', attribution: 'X' } },
      { ...shot(0, 5, 'newspaper'), newspaper: { outlet: 'Variety', date: 'Oct 30, 1929', headline: 'Wall St. Lays an Egg' } },
      { ...shot(0, 5, 'timeline'), timeline: { events: [{ date: '1929', label: 'a' }, { date: '1933', label: 'b' }] } },
      { ...shot(0, 5, 'comparison'), comparison: { left: { value: '3%', label: 'a' }, right: { value: '25%', label: 'b' } } },
      { ...shot(0, 5, 'title'), title_card: { text: 'Part two' } },
      { ...shot(0, 5, 'kinetic_text'), kinetic: { phrase: 'the crowd can be wrong', emphasis: ['wrong'] } },
    ];
    for (const s of specs) {
      const html = motionPageFor(s, theme);
      assert.ok(html?.includes('window.__frame'), `${s.visual_type} page draws frames`);
    }
    assert.ok(!motionPageFor(specs[1], theme)!.includes('<b>bold'), 'text is escaped');
    assert.match(motionPageFor(specs[2], theme)!, /Headline recreation/);
    assert.equal(motionPageFor(shot(0, 5, 'chart'), theme), null, 'no spec, no page');
  });
});
