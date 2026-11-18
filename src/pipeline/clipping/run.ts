import { analyzeClip } from './analyze';
import { downloadClip } from './ingest';
import { writeUploadInfo } from './package';
import { renderShort } from './render';
import { writeScript } from './script';
import { clipDir, loadClip, newClipId, saveClip, updateClip } from './store';
import type { ClipProject, ClipStatus } from './types';
import { voiceLines } from './voice';

/**
 * Runs a clip through download -> analysis -> script -> voice -> render -> export. Clips are
 * processed one at a time (each one works the CPU hard), in the order they were queued.
 *
 *   all:    everything, from the download
 *   script: write a new script from the saved analysis, then voice and render
 *   render: voice any changed lines, then render (after edits)
 */
export type ClipRunFrom = 'all' | 'script' | 'render';

const queueState = globalThis as unknown as { __clipQueue?: Promise<void>; __clipQueued?: Set<string> };

export function isClipBusy(id: string): boolean {
  return queueState.__clipQueued?.has(id) ?? false;
}

/** Queues a clip; returns at once. Progress is written to the clip's project.json. */
export function enqueueClip(id: string, from: ClipRunFrom): void {
  queueState.__clipQueued ??= new Set();
  queueState.__clipQueued.add(id);
  const previous = queueState.__clipQueue ?? Promise.resolve();
  queueState.__clipQueue = previous
    .then(() => processClip(id, from))
    .catch((err) => console.error(`[Clipping] ${id} failed:`, err))
    .finally(() => queueState.__clipQueued?.delete(id));
}

export async function createClip(input: { url: string; creator?: string; note?: string }): Promise<ClipProject> {
  const now = new Date().toISOString();
  const project = await saveClip({
    id: newClipId(),
    sourceUrl: input.url.trim(),
    creator: (input.creator ?? '').trim(),
    note: (input.note ?? '').trim(),
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    step: 'Waiting to start',
    warnings: [],
  });
  enqueueClip(project.id, 'all');
  return project;
}

async function setStatus(id: string, status: ClipStatus, step: string) {
  await updateClip(id, (p) => {
    p.status = status;
    p.step = step;
    delete p.error;
  });
}

export async function processClip(id: string, from: ClipRunFrom): Promise<void> {
  const dir = clipDir(id);
  try {
    let project = await loadClip(id);
    if (!project) return;
    const warnings = from === 'all' ? [] : project.warnings.filter((w) => !/voiced|voiceover|script writer|stills/i.test(w));

    if ((from === 'all' && !project.localSource) || !project.source) {
      await setStatus(id, 'downloading', 'Downloading the clip');
      const source = await downloadClip(project.sourceUrl, dir);
      project = await updateClip(id, (p) => {
        p.source = source;
      });
    }

    if (from === 'all' || !project.analysis) {
      await setStatus(id, 'analyzing', 'Analysing the clip');
      const { analysis, warnings: w } = await analyzeClip(dir, project.source!.file, (step) => setStatus(id, 'analyzing', step));
      warnings.push(...w);
      project = await updateClip(id, (p) => {
        p.analysis = analysis;
      });
    }

    if (from !== 'render' || !project.plan) {
      await setStatus(id, 'writing', 'Writing the hook, voiceover and titles');
      const { plan, warnings: w } = await writeScript(dir, project, project.analysis!, project.plan);
      warnings.push(...w);
      project = await updateClip(id, (p) => {
        p.plan = plan;
      });
    }

    let plan = project.plan!;
    if (plan.voiceover && plan.voiceLines.length) {
      await setStatus(id, 'voicing', 'Recording the voiceover');
      const voiced = await voiceLines(dir, plan.voiceLines, plan.voice);
      warnings.push(...voiced.warnings);
      plan = { ...plan, voiceLines: voiced.lines };
      project = await updateClip(id, (p) => {
        p.plan = plan;
      });
    }

    await setStatus(id, 'rendering', 'Rendering the Short');
    const output = await renderShort(dir, project.source!.file, plan, project.analysis!);
    project = await updateClip(id, (p) => {
      p.output = { ...output, renderedAt: new Date().toISOString() };
      p.status = 'ready';
      p.step = 'Ready';
      p.warnings = [...new Set(warnings)];
    });
    await writeUploadInfo(dir, project);
  } catch (err) {
    await updateClip(id, (p) => {
      p.status = 'failed';
      p.step = 'Failed';
      p.error = err instanceof Error ? err.message : String(err);
    }).catch(() => {});
    throw err;
  }
}
