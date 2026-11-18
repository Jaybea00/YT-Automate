'use client';

import React, { useMemo, useState } from 'react';
import type { FormatDef, FormatPacing } from '@/lib/styles/formats';
import type { NicheDef } from '@/lib/styles/niches';
import { composePack, type StyleLibrary, type WriterVoice } from '@/lib/styles/compose';

/** Editors for the creator's own formats, niches and voices (the packs page). */

export interface StyleOptions {
  themes: Array<{ name: string; background: string; surface: string; text: string; accent: string; accent2: string }>;
  moods: string[];
  captionPresets: string[];
  signatureShots: string[];
  baseStyles: Array<{ id: string; name: string }>;
}

const input = 'w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:border-indigo-500';
const area = `${input} text-xs leading-relaxed font-mono`;
const labelCls = 'block text-xs font-semibold text-zinc-300 mb-1';
const hint = 'block text-[11px] text-zinc-500 mb-1.5';

const SHOT_NAMES: Record<string, string> = {
  pitch: 'Pitch diagram',
  evidence_board: 'Evidence board',
  letter: 'Letter / document',
  race_bars: 'Racing bars',
  scale: 'Scale comparison',
  spec_card: 'Spec card',
  money: 'Money stack',
  shot_map: 'Shot map',
  verse: 'Verse card',
};

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div>
      <span className={labelCls}>{label}</span>
      {help && <span className={hint}>{help}</span>}
      {children}
    </div>
  );
}

function ShotPicker({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((s) => {
        const on = value.includes(s);
        return (
          <button
            key={s}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== s) : [...value, s])}
            className={`px-2.5 py-1 rounded-lg border text-xs ${on ? 'border-indigo-500 bg-indigo-500/15 text-white' : 'border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
          >
            {SHOT_NAMES[s] ?? s}
          </button>
        );
      })}
    </div>
  );
}

/** What the script writer is told for a draft, composed the same way a video would be. */
function WriterPreview({ library, format, niche }: { library: StyleLibrary; format: string; niche: string }) {
  const pack = useMemo(() => {
    try {
      return composePack({ format, niche }, library).pack;
    } catch {
      return null;
    }
  }, [library, format, niche]);
  if (!pack) return null;
  return (
    <details className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <summary className="text-xs text-zinc-400 cursor-pointer">Preview: what the script writer and narrator are told ({pack.label})</summary>
      <pre className="mt-3 whitespace-pre-wrap text-[11px] text-zinc-300 leading-relaxed">{pack.voice}</pre>
      {pack.delivery && <p className="mt-3 text-[11px] text-zinc-400">Narrator: {pack.delivery}</p>}
    </details>
  );
}

function Actions({ saving, error, onCancel, onSave }: { saving: boolean; error: string | null; onCancel: () => void; onSave: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-2">
      <button type="button" onClick={onSave} disabled={saving} className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold disabled:opacity-50">
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-300 text-sm hover:bg-zinc-800">
        Cancel
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

async function saveItem<T>(kind: 'formats' | 'niches' | 'voices', item: unknown): Promise<T> {
  const res = await fetch(`/api/styles/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not save');
  return data.item as T;
}

export function FormatEditor({
  initial,
  library,
  options,
  onSaved,
  onCancel,
}: {
  initial: Partial<FormatDef>;
  library: StyleLibrary;
  options: StyleOptions;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Partial<FormatDef>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<FormatDef>) => setDraft((d) => ({ ...d, ...patch }));
  const emphasis = draft.emphasis?.letterbox ? 'letterbox' : draft.emphasis?.chapterZoom ? 'zoom' : 'none';
  const previewId = draft.id ?? '__draft_format';
  const previewLibrary = useMemo(
    () => ({ ...library, formats: [...library.formats.filter((f) => f.id !== previewId), { ...(draft as FormatDef), id: previewId, custom: true }] }),
    [library, draft, previewId],
  );

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveItem('formats', draft);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 p-5 rounded-xl border border-indigo-500/30 bg-zinc-900">
      <div className="grid grid-cols-[4rem_1fr] gap-3">
        <Field label="Icon">
          <input className={input} value={draft.icon ?? ''} onChange={(e) => set({ icon: e.target.value })} maxLength={8} />
        </Field>
        <Field label="Name">
          <input className={input} value={draft.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Myth vs Fact" />
        </Field>
      </div>
      <Field label="One-line description" help="Shown on the new-video page.">
        <input className={input} value={draft.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <Field label="How the script is built" help="Instructions for the writer: the hook, the middle, the ending, how beats work. Write it the way you'd brief a scriptwriter.">
        <textarea className={area} rows={8} value={draft.structure ?? ''} onChange={(e) => set({ structure: e.target.value })} />
      </Field>
      <Field label="Narrator energy" help="Added to the niche's manner, e.g. “Energetic and upbeat; quick rhythm.”">
        <input className={input} value={draft.energy ?? ''} onChange={(e) => set({ energy: e.target.value })} />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Pacing">
          <select className={input} value={draft.pacing ?? 'normal'} onChange={(e) => set({ pacing: e.target.value as FormatPacing })}>
            <option value="fast">Fast</option>
            <option value="normal">Normal (slower with a slow niche)</option>
            <option value="documentary">Documentary (slower, breathes)</option>
          </select>
        </Field>
        <Field label="Emphasis">
          <select
            className={input}
            value={emphasis}
            onChange={(e) =>
              set({ emphasis: e.target.value === 'letterbox' ? { letterbox: true } : e.target.value === 'zoom' ? { chapterZoom: true } : undefined })
            }
          >
            <option value="none">None</option>
            <option value="zoom">Zoom punch into chapters</option>
            <option value="letterbox">Cinematic letterbox</option>
          </select>
        </Field>
        <Field label="Usual length (min)">
          <input
            className={input}
            type="number"
            min={0.5}
            max={60}
            step={0.5}
            value={draft.suggestedMinutes ?? 10}
            onChange={(e) => set({ suggestedMinutes: parseFloat(e.target.value) || 10 })}
          />
        </Field>
      </div>
      <Field label="Signature shots" help="Special graphics this structure can use.">
        <ShotPicker options={options.signatureShots} value={draft.signatureShots ?? []} onChange={(v) => set({ signatureShots: v as FormatDef['signatureShots'] })} />
      </Field>
      <Field label="Shot director notes (optional)" help="Which graphics suit this structure, e.g. title cards between items.">
        <textarea className={area} rows={3} value={draft.directorNotes ?? ''} onChange={(e) => set({ directorNotes: e.target.value })} />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Transitions and sound like" help="An original style whose transitions and sound palette to borrow.">
          <select className={input} value={draft.baseStyle ?? 'story_driven'} onChange={(e) => set({ baseStyle: e.target.value as FormatDef['baseStyle'] })}>
            {options.baseStyles.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-xs text-zinc-300 mt-6">
          <input type="checkbox" checked={Boolean(draft.chartCallouts)} onChange={(e) => set({ chartCallouts: e.target.checked })} />
          Callouts on charts (“the crash”)
        </label>
      </div>
      <WriterPreview library={previewLibrary} format={previewId} niche="general" />
      <Actions saving={saving} error={error} onCancel={onCancel} onSave={save} />
    </div>
  );
}

export function NicheEditor({
  initial,
  library,
  options,
  formats,
  onSaved,
  onCancel,
}: {
  initial: Partial<NicheDef>;
  library: StyleLibrary;
  options: StyleOptions;
  formats: FormatDef[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Partial<NicheDef>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<NicheDef>) => setDraft((d) => ({ ...d, ...patch }));
  const previewId = draft.id ?? '__draft_niche';
  const previewLibrary = useMemo(
    () => ({ ...library, niches: [...library.niches.filter((n) => n.id !== previewId), { ...(draft as NicheDef), id: previewId, custom: true }] }),
    [library, draft, previewId],
  );
  const previewFormat = draft.suggestedFormats?.[0] ?? 'explainer';

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveItem('niches', draft);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 p-5 rounded-xl border border-indigo-500/30 bg-zinc-900">
      <div className="grid grid-cols-[4rem_1fr] gap-3">
        <Field label="Icon">
          <input className={input} value={draft.icon ?? ''} onChange={(e) => set({ icon: e.target.value })} maxLength={8} />
        </Field>
        <Field label="Name">
          <input className={input} value={draft.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Aviation" />
        </Field>
      </div>
      <Field label="One-line description">
        <input className={input} value={draft.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <Field label="Subject rules" help="What the writer must get right about this subject: accuracy, sensitivity, what to anchor claims in.">
        <textarea className={area} rows={6} value={draft.subject ?? ''} onChange={(e) => set({ subject: e.target.value })} />
      </Field>
      <Field label="Narrator manner" help="How the narrator sounds for this subject, e.g. “Calm and precise.”">
        <input className={input} value={draft.delivery ?? ''} onChange={(e) => set({ delivery: e.target.value })} />
      </Field>
      <Field label="Look" help="Colours, fonts and the colour grade.">
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {options.themes.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => set({ theme: t.name })}
              className={`rounded-lg border p-1.5 text-left ${draft.theme === t.name ? 'border-indigo-500 ring-1 ring-indigo-500' : 'border-zinc-800 hover:border-zinc-700'}`}
            >
              <div className="h-8 rounded flex items-end gap-1 p-1" style={{ background: t.background }}>
                <span className="h-3 w-3 rounded-sm" style={{ background: t.accent }} />
                <span className="h-3 w-3 rounded-sm" style={{ background: t.accent2 }} />
                <span className="h-1.5 flex-1 rounded-sm mb-0.5" style={{ background: t.text, opacity: 0.6 }} />
              </div>
              <span className="block text-[10px] text-zinc-400 mt-1 capitalize">{t.name}</span>
            </button>
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Music mood (fallback)">
          <select className={input} value={draft.fallbackMood ?? 'curious'} onChange={(e) => set({ fallbackMood: e.target.value as NicheDef['fallbackMood'] })}>
            {options.moods.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Caption style">
          <select
            className={input}
            value={draft.captionPreset ?? ''}
            onChange={(e) => set({ captionPreset: (e.target.value || undefined) as NicheDef['captionPreset'] })}
          >
            <option value="">Default</option>
            {options.captionPresets.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Graphics share" help={`${Math.round((draft.maxGraphicsShare ?? 0.55) * 100)}% of screen time at most`}>
          <input
            type="range"
            min={0.2}
            max={0.8}
            step={0.05}
            value={draft.maxGraphicsShare ?? 0.55}
            onChange={(e) => set({ maxGraphicsShare: parseFloat(e.target.value) })}
            className="w-full"
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-zinc-300">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={Boolean(draft.slowNarration)} onChange={(e) => set({ slowNarration: e.target.checked, ...(e.target.checked ? { briskNarration: false } : {}) })} />
          Slower, documentary narration
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={Boolean(draft.briskNarration)} onChange={(e) => set({ briskNarration: e.target.checked, ...(e.target.checked ? { slowNarration: false } : {}) })} />
          Brisk narration, even in story formats
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={Boolean(draft.illustrations)} onChange={(e) => set({ illustrations: e.target.checked })} />
          Labelled AI illustrations allowed
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={Boolean(draft.chartCallouts)} onChange={(e) => set({ chartCallouts: e.target.checked })} />
          Callouts on charts
        </label>
      </div>
      <Field label="Signature shots">
        <ShotPicker options={options.signatureShots} value={draft.signatureShots ?? []} onChange={(v) => set({ signatureShots: v as NicheDef['signatureShots'] })} />
      </Field>
      <Field label="Shot director notes" help="Which footage and graphics suit this subject, and what never to show.">
        <textarea className={area} rows={4} value={draft.directorNotes ?? ''} onChange={(e) => set({ directorNotes: e.target.value })} />
      </Field>
      <Field label="Suggested formats" help="Shown first on the new-video page when this niche is picked.">
        <div className="flex flex-wrap gap-2">
          {formats.map((f) => {
            const on = draft.suggestedFormats?.includes(f.id) ?? false;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() =>
                  set({ suggestedFormats: on ? (draft.suggestedFormats ?? []).filter((x) => x !== f.id) : [...(draft.suggestedFormats ?? []), f.id] })
                }
                className={`px-2.5 py-1 rounded-lg border text-xs ${on ? 'border-emerald-500 bg-emerald-500/10 text-white' : 'border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
              >
                {f.icon} {f.name}
              </button>
            );
          })}
        </div>
      </Field>
      <Field label="Transitions and sound like" help="An original style whose transitions and sound palette to borrow.">
        <select
          className={input}
          value={draft.baseStyle ?? ''}
          onChange={(e) => set({ baseStyle: (e.target.value || null) as NicheDef['baseStyle'] })}
        >
          <option value="">The format’s</option>
          {options.baseStyles.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>
      <WriterPreview library={previewLibrary} format={previewFormat} niche={previewId} />
      <Actions saving={saving} error={error} onCancel={onCancel} onSave={save} />
    </div>
  );
}

export function VoiceEditor({ initial, onSaved, onCancel }: { initial: Partial<WriterVoice>; onSaved: () => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Partial<WriterVoice>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveItem('voices', draft);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-4 p-5 rounded-xl border border-indigo-500/30 bg-zinc-900">
      <Field label="Name" help="e.g. “Bible channel voice”, “Car channel voice”.">
        <input className={input} value={draft.name ?? ''} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
      </Field>
      <Field label="How you write" help="Instructions the writer follows to sound like you: rhythm, how you open and close, humour, phrases you use, things you never say.">
        <textarea className={area} rows={9} value={draft.description ?? ''} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
      </Field>
      <Actions saving={saving} error={error} onCancel={onCancel} onSave={save} />
    </div>
  );
}

export interface DerivedDraft {
  name: string;
  description: string;
  format: string;
  niche: string;
  reasoning: string;
  sourceCount: number;
}

/** Paste a few of your scripts; get a voice to review, name and save. */
export function VoiceDeriver({
  formats,
  niches,
  onDerived,
}: {
  formats: FormatDef[];
  niches: NicheDef[];
  onDerived: (draft: DerivedDraft) => void;
}) {
  const [scripts, setScripts] = useState<string[]>(['', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const words = scripts.join(' ').split(/\s+/).filter(Boolean).length;

  async function derive() {
    setBusy(true);
    setError(null);
    setSuggestion(null);
    try {
      const filled = scripts.filter((s) => s.trim());
      const res = await fetch('/api/styles/derive-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scripts: filled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not derive a voice');
      const d = data.derived as Omit<DerivedDraft, 'sourceCount'>;
      const f = formats.find((x) => x.id === d.format)?.name ?? d.format;
      const n = niches.find((x) => x.id === d.niche)?.name ?? d.niche;
      setSuggestion(`Your scripts are closest to ${f}${d.niche === 'general' ? '' : ` · ${n}`}. ${d.reasoning}`);
      onDerived({ ...d, sourceCount: filled.length });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not derive a voice');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 p-5 rounded-xl border border-zinc-800 bg-zinc-900/60">
      <p className="text-xs text-zinc-400">
        Paste 1 to 5 narration scripts you wrote yourself (at least 150 words in all). The writer studies how you write, not what the videos were
        about, and drafts a voice for you to check, name and save.
      </p>
      {scripts.map((s, i) => (
        <textarea
          key={i}
          rows={5}
          value={s}
          onChange={(e) => setScripts((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
          placeholder={`Script ${i + 1}`}
          className={area}
        />
      ))}
      <div className="flex flex-wrap items-center gap-3">
        {scripts.length < 5 && (
          <button type="button" onClick={() => setScripts((l) => [...l, ''])} className="text-xs text-indigo-400 hover:text-indigo-300">
            + Another script
          </button>
        )}
        <span className="text-xs text-zinc-500">{words} words</span>
        <button
          type="button"
          onClick={derive}
          disabled={busy || words < 150}
          className="ml-auto px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold disabled:opacity-50"
        >
          {busy ? 'Reading your scripts…' : '✨ Derive my voice'}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {suggestion && <p className="text-xs text-emerald-300">{suggestion}</p>}
    </div>
  );
}
