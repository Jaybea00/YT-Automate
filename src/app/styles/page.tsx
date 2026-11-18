'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { FormatDef } from '@/lib/styles/formats';
import type { NicheDef } from '@/lib/styles/niches';
import type { StyleLibrary, WriterVoice } from '@/lib/styles/compose';
import { FormatEditor, NicheEditor, VoiceDeriver, VoiceEditor, type StyleOptions } from './editors';

interface StylesResponse {
  formats: FormatDef[];
  niches: NicheDef[];
  voices: WriterVoice[];
  options: StyleOptions;
}

type Editing =
  | { kind: 'formats'; item: Partial<FormatDef> }
  | { kind: 'niches'; item: Partial<NicheDef> }
  | { kind: 'voices'; item: Partial<WriterVoice> }
  | null;

/** A built-in or saved item as the starting point for a new one of your own. */
function cloneOf<T extends { id?: string; name?: string; custom?: boolean }>(item: T): T {
  const { id: _id, custom: _custom, ...rest } = item;
  void _id;
  void _custom;
  return { ...rest, name: `${item.name ?? 'Untitled'} (my version)` } as T;
}

const NEW_FORMAT: Partial<FormatDef> = { icon: '🧩', pacing: 'normal', suggestedMinutes: 10, signatureShots: [], baseStyle: 'story_driven', energy: '', structure: '' };
const NEW_NICHE: Partial<NicheDef> = {
  icon: '🏷️',
  theme: 'documentary',
  fallbackMood: 'curious',
  signatureShots: [],
  suggestedFormats: ['explainer', 'story'],
  baseStyle: null,
  subject: '',
  delivery: '',
};

export default function StylesPage() {
  const [data, setData] = useState<StylesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/styles');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load packs');
      setData(json as StylesResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load packs');
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const library: StyleLibrary = useMemo(
    () => ({ formats: (data?.formats ?? []).filter((f) => f.custom), niches: (data?.niches ?? []).filter((n) => n.custom), voices: data?.voices ?? [] }),
    [data],
  );

  function saved(message: string) {
    setEditing(null);
    setNotice(message);
    void load();
  }

  async function remove(kind: 'formats' | 'niches' | 'voices', id: string, name: string) {
    if (!window.confirm(`Delete “${name}”? Videos already made with it keep their style.`)) return;
    const res = await fetch(`/api/styles/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setNotice(json.error || 'Could not delete');
      return;
    }
    saved(`Deleted “${name}”.`);
  }

  const editorFor = (kind: 'formats' | 'niches' | 'voices', key: string) => {
    if (!data || !editing || editing.kind !== kind) return null;
    const editingKey = (editing.item as { id?: string }).id ?? '__new';
    if (editingKey !== key) return null;
    if (editing.kind === 'formats')
      return <FormatEditor initial={editing.item} library={library} options={data.options} onSaved={() => saved('Format saved.')} onCancel={() => setEditing(null)} />;
    if (editing.kind === 'niches')
      return (
        <NicheEditor
          initial={editing.item}
          library={library}
          options={data.options}
          formats={data.formats}
          onSaved={() => saved('Niche saved.')}
          onCancel={() => setEditing(null)}
        />
      );
    return <VoiceEditor initial={editing.item} onSaved={() => saved('Voice saved.')} onCancel={() => setEditing(null)} />;
  };

  const row = (
    kind: 'formats' | 'niches',
    item: FormatDef | NicheDef,
  ) => (
    <div key={item.id} className="space-y-3">
      <div className="flex items-start gap-3 p-3 rounded-xl border border-zinc-800 bg-zinc-950/50">
        <span className="text-lg leading-none mt-0.5">{item.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100">{item.name}</span>
            {item.custom ? (
              <span className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-1.5">yours</span>
            ) : (
              <span className="text-[10px] text-zinc-500 border border-zinc-800 rounded px-1.5">built in</span>
            )}
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">{item.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {item.custom ? (
            <>
              <button type="button" onClick={() => setEditing({ kind, item } as Editing)} className="text-xs text-indigo-400 hover:text-indigo-300">
                Edit
              </button>
              <button type="button" onClick={() => remove(kind, item.id, item.name)} className="text-xs text-red-400 hover:text-red-300">
                Delete
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setEditing({ kind, item: cloneOf(item) } as Editing)} className="text-xs text-indigo-400 hover:text-indigo-300">
              Clone &amp; edit
            </button>
          )}
        </div>
      </div>
      {item.custom && editorFor(kind, item.id)}
    </div>
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 py-12 px-4 sm:px-6 lg:px-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-10">
        <div>
          <div className="flex items-center gap-2 text-sm text-zinc-400 mb-6">
            <Link href="/" className="hover:text-zinc-200">
              Pipeline Dashboard
            </Link>
            <span>/</span>
            <span className="text-zinc-200 font-medium">Packs &amp; voices</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Packs &amp; voices</h1>
          <p className="text-sm text-zinc-400 mt-1 max-w-2xl">
            A video’s style is a <strong className="text-zinc-200">format</strong> (how it’s built) plus a <strong className="text-zinc-200">niche</strong>{' '}
            (what it’s about and how it looks). Clone a built-in one to make your own, and save your writing <strong className="text-zinc-200">voices</strong>{' '}
            so scripts sound like you. Every video keeps the style it was made with, so editing here never changes finished videos.
          </p>
          {notice && <p className="mt-3 text-xs text-emerald-300">{notice}</p>}
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        </div>

        {!data && !error && <p className="text-sm text-zinc-500">Loading…</p>}

        {data && (
          <>
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-white">Formats</h2>
                <button type="button" onClick={() => setEditing({ kind: 'formats', item: { ...NEW_FORMAT } })} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700">
                  + New format
                </button>
              </div>
              {editing?.kind === 'formats' && !(editing.item as { id?: string }).id && editorFor('formats', '__new')}
              <div className="space-y-2">{[...data.formats].sort((a, b) => Number(Boolean(b.custom)) - Number(Boolean(a.custom))).map((f) => row('formats', f))}</div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-white">Niches</h2>
                <button type="button" onClick={() => setEditing({ kind: 'niches', item: { ...NEW_NICHE } })} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700">
                  + New niche
                </button>
              </div>
              {editing?.kind === 'niches' && !(editing.item as { id?: string }).id && editorFor('niches', '__new')}
              <div className="space-y-2">{[...data.niches].sort((a, b) => Number(Boolean(b.custom)) - Number(Boolean(a.custom))).map((n) => row('niches', n))}</div>
            </section>

            <section id="voices" className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-white">Your voices</h2>
                <button type="button" onClick={() => setEditing({ kind: 'voices', item: { name: '', description: '' } })} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700">
                  + Write one by hand
                </button>
              </div>
              <p className="text-xs text-zinc-500">
                A voice is how you write. Pick one when creating a video (under More options) and the script is written to sound like you. Keep one per
                channel if your channels sound different.
              </p>
              <VoiceDeriver
                formats={data.formats}
                niches={data.niches}
                onDerived={(d) =>
                  setEditing({ kind: 'voices', item: { name: d.name, description: d.description, sourceCount: d.sourceCount } })
                }
              />
              {editing?.kind === 'voices' && !(editing.item as { id?: string }).id && editorFor('voices', '__new')}
              <div className="space-y-2">
                {data.voices.length === 0 && <p className="text-xs text-zinc-500">No voices yet.</p>}
                {data.voices.map((v) => (
                  <div key={v.id} className="space-y-3">
                    <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950/50">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-zinc-100">🗣️ {v.name}</span>
                        {v.sourceCount ? <span className="text-[10px] text-zinc-500">from {v.sourceCount} script{v.sourceCount === 1 ? '' : 's'}</span> : null}
                        <span className="ml-auto flex gap-3">
                          <button type="button" onClick={() => setEditing({ kind: 'voices', item: v })} className="text-xs text-indigo-400 hover:text-indigo-300">
                            Edit
                          </button>
                          <button type="button" onClick={() => remove('voices', v.id, v.name)} className="text-xs text-red-400 hover:text-red-300">
                            Delete
                          </button>
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1.5 whitespace-pre-line line-clamp-4">{v.description}</p>
                    </div>
                    {editorFor('voices', v.id)}
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
