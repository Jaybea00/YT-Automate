import * as path from 'node:path';
import { voiceLines } from '../clipping/voice';
import { analyzeItem } from './analyze';
import { listLibrary } from './library';
import { writeCompilationUploadInfo } from './package';
import { renderCompilation } from './render';
import { writeCompilationScript } from './script';
import { DEFAULT_COUNT, orderClips, pickForTheme, themeName, trimToBudget, type ThemeFilter } from './select';
import { compilationDir, loadCompilation, newCompilationId, saveCompilation, updateCompilation } from './store';
import { SHORT_MAX_SEC, type Compilation, type CompilationFormat, type CompilationItem, type LibraryItem } from './types';

/**
 * Runs a compilation: analyse each clip -> (Shorts) fit the clips into a minute -> write the script
 * -> voice the cards (long form) -> render. One compilation at a time.
 *
 *   all:    from the analysis, with a fresh script and fresh trims
 *   script: a fresh script, then voice and render
 *   render: after edits; voices changed lines, analyses added clips, keeps everything else
 */
export type CompilationRunFrom = 'all' | 'script' | 'render';

const state = globalThis as unknown as { __compQueue?: Promise<void>; __compQueued?: Set<string> };
export const isCompilationBusy = (id: string) => state.__compQueued?.has(id) ?? false;

export function enqueueCompilation(id: string, from: CompilationRunFrom): void {
  state.__compQueued ??= new Set();
  state.__compQueued.add(id);
  state.__compQueue = (state.__compQueue ?? Promise.resolve())
    .then(() => processCompilation(id, from))
    .catch((err) => console.error(`[Compilations] ${id} failed:`, err))
    .finally(() => state.__compQueued?.delete(id));
}

export function itemFromLibrary(l: LibraryItem): CompilationItem {
  return {
    key: l.key,
    start: l.start,
    end: l.end,
    label: '',
    line: '',
    file: l.file,
    creator: l.creator,
    pageUrl: l.pageUrl,
    title: l.title,
    description: l.description,
    recipe: l.recipe,
    score: l.score,
  };
}

/**
 * A new compilation from chosen library keys, or from a theme (the best matching clips). It
 * starts right away; the clips are put in running order.
 */
export async function createCompilation(input: { format: CompilationFormat; keys?: string[]; theme?: ThemeFilter; count?: number; title?: string }): Promise<Compilation> {
  const library = await listLibrary();
  let chosen: LibraryItem[];
  if (input.keys?.length) {
    chosen = input.keys.map((k) => library.find((l) => l.key === k)).filter((l): l is LibraryItem => Boolean(l));
  } else if (input.theme) {
    chosen = pickForTheme(library, input.theme, input.count ?? DEFAULT_COUNT[input.format]);
  } else {
    throw new Error('Choose clips or a theme');
  }
  if (chosen.length < 2) throw new Error('A compilation needs at least 2 clips');
  if (input.format === 'short' && chosen.length > 6) chosen = chosen.slice(0, 6);

  const now = new Date().toISOString();
  const c = await saveCompilation({
    id: newCompilationId(),
    format: input.format,
    title: '',
    theme: input.title?.trim() || (input.theme ? themeName(input.theme) : 'Best GTA 6 moments'),
    // Hand-picked clips keep the order they were picked in; a theme's are put in running order
    items: input.keys?.length ? chosen.map(itemFromLibrary) : orderClips(chosen.map(itemFromLibrary)),
    hook: '',
    intro: '',
    outro: '',
    titles: [],
    description: '',
    tags: [],
    options: { captions: true, cleanCaptions: true, nameCards: true, voiceover: input.format === 'long', crop: true, voice: '' },
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    step: 'Waiting to start',
    warnings: [],
    analysis: {},
    voice: {},
  });
  enqueueCompilation(c.id, 'all');
  return c;
}

async function setStep(id: string, status: Compilation['status'], step: string, progress?: number) {
  await updateCompilation(id, (c) => {
    c.status = status;
    c.step = step;
    c.progress = progress;
    delete c.error;
  });
}

/** Shorts: each clip gets an equal share of the minute, cut around its loudest moment. */
export function fitShortItems(c: Compilation): CompilationItem[] {
  const budget = SHORT_MAX_SEC / Math.max(1, c.items.length);
  return c.items.map((it) => {
    const a = c.analysis[it.key];
    const range = { start: it.start, end: a ? Math.min(it.end, a.durationSec) : it.end };
    return { ...it, ...trimToBudget(range, a?.peakSec ?? null, budget) };
  });
}

export async function processCompilation(id: string, from: CompilationRunFrom): Promise<void> {
  const dir = compilationDir(id);
  try {
    let c = await loadCompilation(id);
    if (!c) return;
    const warnings: string[] = from === 'render' ? c.warnings.filter((w) => !/voiced|transcribed|render/i.test(w)) : [];

    // Analyse any clip not yet analysed
    const todo = c.items.filter((it) => !c!.analysis[it.key]);
    for (const [i, it] of todo.entries()) {
      await setStep(id, 'analyzing', `Listening to clip ${i + 1} of ${todo.length}`, Math.floor((i / todo.length) * 100));
      const { analysis, warning } = await analyzeItem(it.file, { start: it.start, end: it.end }, path.join(dir, 'work'));
      if (warning) warnings.push(warning);
      c = await updateCompilation(id, (x) => {
        x.analysis[it.key] = analysis;
      });
    }

    if (from === 'all' && c.format === 'short') {
      const fitted = fitShortItems(c);
      c = await updateCompilation(id, (x) => {
        x.items = fitted;
      });
    }

    if (from !== 'render' || !c.titles.length) {
      await setStep(id, 'writing', 'Writing titles, hook and voiceover');
      const { script, warning } = await writeCompilationScript(c);
      if (warning) warnings.push(warning);
      c = await updateCompilation(id, (x) => {
        x.titles = script.titles.map((t) => t.trim()).filter(Boolean).slice(0, 5);
        x.description = script.description.trim();
        x.tags = [...new Set(script.tags.map((t) => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean))].slice(0, 15);
        x.hook = script.hook.trim().slice(0, 70);
        x.intro = script.intro.trim();
        x.outro = script.outro.trim();
        x.items = x.items.map((it, i) => ({ ...it, label: script.items[i]?.label.trim() || it.label, line: script.items[i]?.line.trim() || it.line }));
      });
    }

    // Long form: voice the intro, each card and the outro
    if (c.format === 'long' && c.options.voiceover) {
      await setStep(id, 'voicing', 'Recording the voiceover');
      const wanted = [
        { key: 'intro', text: c.intro },
        ...c.items.map((it) => ({ key: it.key, text: it.line })),
        { key: 'outro', text: c.outro },
      ].filter((l) => l.text.trim());
      const voiced = await voiceLines(
        dir,
        wanted.map((l) => ({ at: 0, text: l.text, slot: 'other' as const, audioFile: c!.voice[l.key]?.file, audioKey: c!.voice[l.key]?.key })),
        c.options.voice,
      );
      warnings.push(...voiced.warnings.slice(0, 1));
      c = await updateCompilation(id, (x) => {
        x.voice = {};
        wanted.forEach((l, i) => {
          const v = voiced.lines[i];
          if (v?.audioFile && v.audioKey && v.durationSec) x.voice[l.key] = { text: l.text, file: v.audioFile, durationSec: v.durationSec, key: v.audioKey };
        });
      });
    }

    const total = c.items.length + (c.format === 'long' ? c.items.length + 2 : 0);
    await setStep(id, 'rendering', `Rendering part 1 of ${total}`, 0);
    const output = await renderCompilation(dir, c, (done, all) => setStep(id, 'rendering', `Rendering part ${Math.min(done + 1, all)} of ${all}`, Math.floor((done / all) * 100)));
    if (c.format === 'short' && output.durationSec > 60) warnings.push(`The Short is ${output.durationSec.toFixed(0)}s long; trim the clips to stay under 60s.`);
    c = await updateCompilation(id, (x) => {
      x.output = { ...output, renderedAt: new Date().toISOString() };
      x.status = 'ready';
      x.step = 'Ready';
      x.progress = undefined;
      x.warnings = [...new Set(warnings)];
    });
    await writeCompilationUploadInfo(dir, c);
  } catch (err) {
    await updateCompilation(id, (x) => {
      x.status = 'failed';
      x.step = 'Failed';
      x.progress = undefined;
      x.error = err instanceof Error ? err.message : String(err);
    }).catch(() => {});
    throw err;
  }
}
