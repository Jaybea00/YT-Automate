/**
 * Guide Shorts from the command line:
 *   npm run guide -- new <id>      a folder under storage/guides with a guide.json to fill in
 *   npm run guide -- sheet <id>    a contact sheet of every recording in footage/ (to pick the shots)
 *   npm run guide -- render <id>   voice it (Kokoro must be running) and render export/short.mp4
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadChannelProfile } from '../channel/store';
import { getFfmpegPath } from '../utils/ffmpeg';
import { renderGuide, voiceGuide } from './render';
import { createGuide, guideDir, loadGuide, probeFootage, saveGuide } from './store';

const execFileAsync = promisify(execFile);
const VIDEO = /\.(mp4|mov|mkv|webm|m4v)$/i;
/** Seconds between the frames of a contact sheet. */
const SHEET_STEP = 2;

async function sheet(id: string) {
  const dir = guideDir(id);
  const footage = path.join(dir, 'footage');
  const files = (await fs.readdir(footage).catch(() => [])).filter((f) => VIDEO.test(f)).sort();
  if (!files.length) throw new Error(`No recordings in ${footage}`);
  await fs.mkdir(path.join(dir, 'sheets'), { recursive: true });
  for (const f of files) {
    const info = await probeFootage(path.join(footage, f));
    const n = Math.max(1, Math.ceil(info.durationSec / SHEET_STEP));
    const cols = 6;
    const rows = Math.ceil(n / cols);
    const out = path.join(dir, 'sheets', `${f.replace(VIDEO, '')}.jpg`);
    await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-i', path.join(footage, f), '-vf', `fps=1/${SHEET_STEP},scale=320:-2,tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '3', out]);
    console.log(`${f}: ${info.width}x${info.height}, ${info.durationSec.toFixed(1)} s, ${info.hasAudio ? 'with' : 'no'} sound -> sheets/${path.basename(out)} (one frame every ${SHEET_STEP} s, left to right)`);
  }
}

async function render(id: string) {
  const project = await loadGuide(id);
  if (!project) throw new Error(`No guide "${id}"`);
  const dir = guideDir(id);
  const channel = await loadChannelProfile();
  console.log('Voicing…');
  const { voiced, warnings: voiceWarnings } = await voiceGuide(dir, project, channel.voice);
  project.voiced = voiced;
  await saveGuide(project);
  // A voice that failed on every line: stop, rather than render (and overwrite the last video with) a silent one
  if (voiced.length && !voiced.some((v) => v.audioFile)) {
    for (const w of voiceWarnings.slice(0, 3)) console.warn(`! ${w}`);
    throw new Error('Nothing could be voiced, so nothing was rendered (the last video is untouched).');
  }
  console.log('Rendering…');
  const out = await renderGuide(dir, project, channel);
  const warnings = [...voiceWarnings, ...out.warnings];
  await saveGuide({ ...project, warnings, output: { video: out.video, thumbnail: out.thumbnail, renderedAt: new Date().toISOString(), durationSec: out.durationSec } });
  for (const w of warnings) console.warn(`! ${w}`);
  console.log(`Done: ${path.join(dir, out.video)} (${out.durationSec.toFixed(1)} s)`);
}

const [command, id] = process.argv.slice(2);
const run = async () => {
  if (command === 'new' && id) {
    await createGuide(id);
    console.log(`Made ${guideDir(id)}: put the recordings in footage/, then fill in guide.json`);
  } else if (command === 'sheet' && id) await sheet(id);
  else if (command === 'render' && id) await render(id);
  else {
    console.log('Usage: npm run guide -- new|sheet|render <id>');
    process.exitCode = 1;
  }
};
run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
