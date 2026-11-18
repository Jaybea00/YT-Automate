import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CAPTION_PRESETS, type CaptionPreset } from '@/pipeline/assembly/captions';
import { MOODS, type Mood } from '@/pipeline/assembly/music-library';
import { BUILT_IN_FORMATS, type FormatDef, type FormatPacing, type SignatureShot } from './formats';
import { BUILT_IN_NICHES, type NicheDef } from './niches';
import { EMPTY_LIBRARY, type StyleLibrary, type WriterVoice } from './compose';
import { isVideoStyle, type VideoStyle } from './packs';
import { ALL_THEMES } from './themes';

/**
 * The creator's own formats, niches and writing voices, kept with other channel settings under
 * storage/settings (like the pronunciation list). Server only.
 */

export function styleLibraryFile(): string {
  return process.env.STYLE_LIBRARY_FILE || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'settings', 'style-library.json');
}

export const SIGNATURE_SHOTS: SignatureShot[] = ['pitch', 'evidence_board', 'letter', 'race_bars', 'scale', 'spec_card', 'money', 'shot_map', 'verse'];
const PACINGS: FormatPacing[] = ['fast', 'normal', 'documentary'];

const MAX_TEXT = 4000;
const text = (v: unknown, max = MAX_TEXT) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const share = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.2 && n <= 0.8 ? Math.round(n * 100) / 100 : undefined;
};

export function newId(prefix: 'cf' | 'cn' | 'v'): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

/** A custom format as saved: every field checked. Throws with a readable message when it can't be used. */
export function sanitizeFormat(raw: unknown, id?: string): FormatDef {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = text(r.name, 60);
  const structure = text(r.structure);
  if (!name) throw new Error('A format needs a name.');
  if (structure.length < 40) throw new Error('Describe how the script is built (at least a couple of sentences).');
  const emphasis = r.emphasis as { chapterZoom?: unknown; letterbox?: unknown } | undefined;
  const minutes = Number(r.suggestedMinutes);
  const base = isVideoStyle(r.baseStyle) && !['stickman_pov', 'stickman_bible'].includes(r.baseStyle as string) ? (r.baseStyle as VideoStyle) : 'story_driven';
  return {
    id: id ?? (typeof r.id === 'string' && r.id.startsWith('cf_') ? r.id : newId('cf')),
    name,
    icon: text(r.icon, 8) || '🧩',
    description: text(r.description, 200),
    structure,
    energy: text(r.energy, 300),
    pacing: oneOf(r.pacing, PACINGS, 'normal'),
    ...(emphasis?.letterbox || emphasis?.chapterZoom
      ? { emphasis: { ...(emphasis.letterbox ? { letterbox: true } : { chapterZoom: true }) } }
      : {}),
    signatureShots: Array.isArray(r.signatureShots) ? SIGNATURE_SHOTS.filter((s) => (r.signatureShots as unknown[]).includes(s)) : [],
    ...(text(r.directorNotes) ? { directorNotes: text(r.directorNotes) } : {}),
    ...(r.chartCallouts ? { chartCallouts: true } : {}),
    ...(MOODS.includes(r.mood as Mood) ? { mood: r.mood as Mood } : {}),
    suggestedMinutes: Number.isFinite(minutes) && minutes >= 0.5 && minutes <= 60 ? Math.round(minutes * 2) / 2 : 10,
    baseStyle: base,
    custom: true,
  };
}

/** A custom niche as saved: every field checked. */
export function sanitizeNiche(raw: unknown, id?: string, formatIds: string[] = BUILT_IN_FORMATS.map((f) => f.id)): NicheDef {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = text(r.name, 60);
  if (!name) throw new Error('A niche needs a name.');
  const themes = ALL_THEMES.map((t) => t.name);
  const base = isVideoStyle(r.baseStyle) && !['stickman_pov', 'stickman_bible'].includes(r.baseStyle as string) ? (r.baseStyle as VideoStyle) : null;
  const preset = r.captionPreset && CAPTION_PRESETS.includes(r.captionPreset as CaptionPreset) ? (r.captionPreset as CaptionPreset) : undefined;
  const maxShare = share(r.maxGraphicsShare);
  return {
    id: id ?? (typeof r.id === 'string' && r.id.startsWith('cn_') ? r.id : newId('cn')),
    name,
    icon: text(r.icon, 8) || '🏷️',
    description: text(r.description, 200),
    subject: text(r.subject),
    delivery: text(r.delivery, 300),
    theme: oneOf(r.theme, themes, 'documentary'),
    ...(typeof r.drawnTheme === 'string' && themes.includes(r.drawnTheme) ? { drawnTheme: r.drawnTheme } : {}),
    fallbackMood: oneOf<Mood>(r.fallbackMood, MOODS, 'curious'),
    ...(r.slowNarration ? { slowNarration: true } : {}),
    ...(r.briskNarration && !r.slowNarration ? { briskNarration: true } : {}),
    ...(text(r.directorNotes) ? { directorNotes: text(r.directorNotes) } : {}),
    ...(maxShare !== undefined ? { maxGraphicsShare: maxShare } : {}),
    signatureShots: Array.isArray(r.signatureShots) ? SIGNATURE_SHOTS.filter((s) => (r.signatureShots as unknown[]).includes(s)) : [],
    ...(r.illustrations ? { illustrations: true } : {}),
    ...(r.chartCallouts ? { chartCallouts: true } : {}),
    ...(preset ? { captionPreset: preset } : {}),
    suggestedFormats: Array.isArray(r.suggestedFormats) ? (r.suggestedFormats as unknown[]).filter((f): f is string => typeof f === 'string' && formatIds.includes(f)).slice(0, 6) : [],
    baseStyle: base,
    custom: true,
  };
}

export function sanitizeVoice(raw: unknown, id?: string): WriterVoice {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = text(r.name, 60);
  const description = text(r.description, 3000);
  if (!name) throw new Error('A voice needs a name.');
  if (description.length < 20) throw new Error('Describe how you write (at least a sentence or two).');
  const count = Number(r.sourceCount);
  return {
    id: id ?? (typeof r.id === 'string' && r.id.startsWith('v_') ? r.id : newId('v')),
    name,
    description,
    createdAt: typeof r.createdAt === 'string' && !Number.isNaN(Date.parse(r.createdAt)) ? r.createdAt : new Date().toISOString(),
    ...(Number.isInteger(count) && count > 0 ? { sourceCount: count } : {}),
  };
}

/** Whatever is in the file, kept only where it's still valid (a bad entry never breaks the rest). */
export function sanitizeLibrary(raw: unknown): StyleLibrary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const keep = <T,>(list: unknown, fn: (x: unknown) => T): T[] => {
    if (!Array.isArray(list)) return [];
    const out: T[] = [];
    for (const item of list) {
      try {
        out.push(fn(item));
      } catch {
        // skip an entry that can't be used
      }
    }
    return out;
  };
  const builtIn = new Set([...BUILT_IN_FORMATS.map((f) => f.id), ...BUILT_IN_NICHES.map((n) => n.id)]);
  const formats = keep(r.formats, (x) => sanitizeFormat(x, (x as { id?: string })?.id)).filter((f) => !builtIn.has(f.id));
  const formatIds = [...BUILT_IN_FORMATS.map((f) => f.id), ...formats.map((f) => f.id)];
  const niches = keep(r.niches, (x) => sanitizeNiche(x, (x as { id?: string })?.id, formatIds)).filter((n) => !builtIn.has(n.id));
  const voices = keep(r.voices, (x) => sanitizeVoice(x, (x as { id?: string })?.id));
  return { formats, niches, voices };
}

export async function loadStyleLibrary(file = styleLibraryFile()): Promise<StyleLibrary> {
  try {
    return sanitizeLibrary(JSON.parse(await fs.readFile(file, 'utf-8')));
  } catch {
    return { ...EMPTY_LIBRARY };
  }
}

export async function saveStyleLibrary(library: StyleLibrary, file = styleLibraryFile()): Promise<StyleLibrary> {
  const clean = sanitizeLibrary(library);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Written to a temporary file first so a crash mid-write never leaves a half-written library
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(clean, null, 2), 'utf-8');
  await fs.rename(temp, file);
  return clean;
}

export type LibraryKind = 'formats' | 'niches' | 'voices';

export function isLibraryKind(v: unknown): v is LibraryKind {
  return v === 'formats' || v === 'niches' || v === 'voices';
}

/** Adds an item, or replaces the one with the same id. Returns the saved item and library. */
export async function upsertLibraryItem(kind: LibraryKind, raw: unknown, file = styleLibraryFile()) {
  const library = await loadStyleLibrary(file);
  const rawId = typeof (raw as { id?: unknown })?.id === 'string' ? ((raw as { id: string }).id) : undefined;
  const existingId = rawId && (library[kind] as Array<{ id: string }>).some((x) => x.id === rawId) ? rawId : undefined;
  let item: FormatDef | NicheDef | WriterVoice;
  if (kind === 'formats') item = sanitizeFormat(raw, existingId);
  else if (kind === 'niches') item = sanitizeNiche(raw, existingId, [...BUILT_IN_FORMATS, ...library.formats].map((f) => f.id));
  else item = sanitizeVoice(raw, existingId);
  const list = (library[kind] as Array<{ id: string }>).filter((x) => x.id !== item.id);
  const next = { ...library, [kind]: [...list, item] } as StyleLibrary;
  const saved = await saveStyleLibrary(next, file);
  return { item, library: saved };
}

export async function deleteLibraryItem(kind: LibraryKind, id: string, file = styleLibraryFile()): Promise<{ deleted: boolean; library: StyleLibrary }> {
  const library = await loadStyleLibrary(file);
  const list = library[kind] as Array<{ id: string }>;
  if (!list.some((x) => x.id === id)) return { deleted: false, library };
  const next = { ...library, [kind]: list.filter((x) => x.id !== id) } as StyleLibrary;
  return { deleted: true, library: await saveStyleLibrary(next, file) };
}
