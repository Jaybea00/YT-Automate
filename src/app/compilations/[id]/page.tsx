'use client';

import React, { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Compilation, CompilationItem } from '@/pipeline/compile/types';

interface LibraryRow {
  key: string;
  title: string;
  creator: string;
  durationSec: number;
}

const terminal = (s?: string) => s === 'ready' || s === 'failed' || s === 'draft';
const card = 'rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3';
const input = 'w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm';
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

function Num({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      step={0.5}
      min={0}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => onChange(Number.parseFloat(e.target.value) || 0)}
      className="w-16 bg-zinc-950 border border-zinc-800 rounded-md px-1.5 py-1 text-xs"
    />
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-red-500" />
      {label}
    </label>
  );
}

/** One compilation: watch it, reorder and trim clips, edit the words, re-render, download. */
export default function CompilationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [comp, setComp] = useState<Compilation | null>(null);
  const [draft, setDraft] = useState<Compilation | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadDescription, setUploadDescription] = useState('');
  const [library, setLibrary] = useState<LibraryRow[]>([]);
  const [adding, setAdding] = useState('');
  const [dirty, setDirty] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  type Loaded = { compilation: Compilation; busy: boolean; uploadDescription: string } | null;
  const fetchComp = useCallback(async (): Promise<Loaded> => {
    const res = await fetch(`/api/compilations/${id}`, { cache: 'no-store' });
    return res.status === 404 ? null : ((await res.json()) as Loaded);
  }, [id]);
  const apply = useCallback((d: Loaded) => {
    if (!d) return setNotFound(true);
    setComp(d.compilation);
    setBusy(d.busy);
    setUploadDescription(d.uploadDescription);
    if (!dirtyRef.current) setDraft(d.compilation);
  }, []);
  const load = useCallback(() => fetchComp().then(apply).catch(() => {}), [fetchComp, apply]);

  useEffect(() => {
    let cancelled = false;
    fetchComp()
      .then((d) => {
        if (!cancelled) apply(d);
      })
      .catch(() => {});
    fetch('/api/moments', { cache: 'no-store' })
      .then((r) => r.json() as Promise<{ items: LibraryRow[] }>)
      .then((d) => {
        if (!cancelled) setLibrary(d.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchComp, apply]);

  const working = busy || (comp !== null && !terminal(comp.status));
  useEffect(() => {
    if (!working) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [working, load]);

  const edit = (change: Partial<Compilation>) => {
    setDraft((d) => (d ? { ...d, ...change } : d));
    setDirty(true);
  };
  const setItem = (i: number, change: Partial<CompilationItem>) => edit({ items: draft!.items.map((it, k) => (k === i ? { ...it, ...change } : it)) });
  const move = (i: number, by: number) => {
    const items = [...draft!.items];
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    edit({ items });
  };

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    setError(null);
    const body = {
      theme: draft.theme,
      hook: draft.hook,
      intro: draft.intro,
      outro: draft.outro,
      titles: draft.titles,
      description: draft.description,
      tags: draft.tags,
      options: draft.options,
      items: draft.items.map((it) => ({ key: it.key, start: it.start, end: it.end, label: it.label, line: it.line })),
    };
    const res = await fetch(`/api/compilations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json()) as { compilation?: Compilation; uploadDescription?: string; error?: string };
    if (!data.compilation) {
      setError(data.error || 'Could not save');
      return false;
    }
    setComp(data.compilation);
    setDraft(data.compilation);
    setUploadDescription(data.uploadDescription ?? '');
    setDirty(false);
    return true;
  };

  const run = async (from: 'render' | 'script' | 'all') => {
    if (from === 'render' && dirty && !(await save())) return;
    if (from !== 'render' && !confirm(from === 'all' ? 'Re-fit every clip and rewrite all the words? Your trims and edits are replaced.' : 'Rewrite the titles, hook, labels and voiceover? Your edits to them are replaced.')) return;
    setError(null);
    const res = await fetch(`/api/compilations/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from }) });
    if (!res.ok) setError(((await res.json()) as { error?: string }).error || 'Could not start');
    setDirty(false);
    await load();
  };

  const addClip = () => {
    const row = library.find((l) => l.key === adding);
    if (!row || !draft || draft.items.some((it) => it.key === row.key)) return;
    // Filled in from the library when saved
    edit({ items: [...draft.items, { key: row.key, start: 0, end: row.durationSec, label: '', line: '', file: '', creator: row.creator, pageUrl: '', title: row.title, description: '', recipe: 'other', score: null }] });
    setAdding('');
  };

  const remove = async () => {
    if (!confirm('Delete this compilation? The clips stay in your library.')) return;
    const res = await fetch(`/api/compilations/${id}`, { method: 'DELETE' });
    if (res.ok) router.push('/moments');
    else setError(((await res.json()) as { error?: string }).error || 'Could not delete');
  };

  if (notFound) return <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8">Compilation not found. <Link href="/moments" className="underline">Back</Link></div>;
  if (!comp || !draft) return <div className="min-h-screen bg-zinc-950 text-zinc-400 p-8">Loading…</div>;

  const short = draft.format === 'short';
  const n = draft.items.length;
  const total = draft.items.reduce((s, it) => s + (it.end - it.start), 0);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <Link href="/moments" className="text-sm text-zinc-500 hover:text-zinc-300">← Moments</Link>
            <h1 className="text-xl font-bold mt-1 truncate">{comp.titles[0] || comp.theme}</h1>
            <p className="text-xs text-zinc-500">{short ? 'Short (9:16)' : 'Countdown (16:9)'} · {n} clips · {short ? `${total.toFixed(0)}s of clips` : `${mmss(total)} of clips`}</p>
          </div>
          <button onClick={remove} disabled={working} className="text-xs text-zinc-500 hover:text-red-400 disabled:opacity-40">Delete</button>
        </div>

        {working && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200 space-y-2">
            <div><span className="animate-pulse">●</span> {comp.step}</div>
            {comp.progress != null && (
              <div className="h-1.5 rounded-full bg-amber-500/20 overflow-hidden">
                <div className="h-full bg-amber-400 transition-all" style={{ width: `${comp.progress}%` }} />
              </div>
            )}
          </div>
        )}
        {comp.status === 'failed' && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200 flex items-center justify-between gap-3 flex-wrap">
            <span>{comp.error}</span>
            <button onClick={() => run('render')} className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold">Try again</button>
          </div>
        )}
        {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}
        {comp.warnings.length > 0 && !working && (
          <ul className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-amber-300/90 space-y-1 list-disc pl-6">{comp.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        )}

        <div className={`grid gap-5 items-start ${short ? 'lg:grid-cols-[340px_1fr]' : ''}`}>
          <div className="space-y-3 lg:sticky lg:top-4">
            {comp.output ? (
              <video key={comp.output.renderedAt} src={`/api/compilations/${id}/file?name=video&v=${encodeURIComponent(comp.output.renderedAt)}`} controls playsInline className={`w-full rounded-2xl bg-black border border-zinc-800 ${short ? 'aspect-[9/16]' : 'aspect-video'}`} />
            ) : (
              <div className={`w-full rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-sm text-zinc-500 ${short ? 'aspect-[9/16]' : 'aspect-video'}`}>{working ? 'Making your compilation…' : 'Not rendered yet'}</div>
            )}
            {comp.output && (
              <div className={`grid gap-2 ${short ? '' : 'sm:grid-cols-3'}`}>
                <a href={`/api/compilations/${id}/file?name=package`} className="text-center px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-sm">⬇ Export package (.zip)</a>
                <a href={`/api/compilations/${id}/file?name=video&download=1`} className="text-center px-3 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm">Video ({mmss(comp.output.durationSec)})</a>
                <a href={`/api/compilations/${id}/file?name=thumbnail&download=1`} className="text-center px-3 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm">Thumbnail</a>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className={card}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h2 className="font-semibold">Clips (in order)</h2>
                <button onClick={() => run('render')} disabled={working} className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white font-semibold text-sm">
                  {dirty ? 'Save & re-render' : 'Re-render'}
                </button>
              </div>
              {short && total > 60 && <p className="text-xs text-amber-300">The clips add up to {total.toFixed(0)}s; trim them to stay under 60s.</p>}
              {draft.items.map((it, i) => (
                <div key={it.key} className="flex gap-3 items-start border-t border-zinc-800 pt-3 first:border-0 first:pt-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/moments/media?key=${encodeURIComponent(it.key)}&kind=thumb`} alt="" className="w-24 aspect-video object-cover rounded-md bg-zinc-800 shrink-0" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 text-xs text-zinc-400">
                      <span className="font-bold text-zinc-200">{short ? i + 1 : `#${n - i}`}</span>
                      <span className="truncate">{it.title}</span>
                      <span className="shrink-0">· {it.creator}</span>
                    </div>
                    <input value={it.label} onChange={(e) => setItem(i, { label: e.target.value })} placeholder="Label" className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-sm" />
                    {!short && <input value={it.line} onChange={(e) => setItem(i, { line: e.target.value })} placeholder="Voiceover before the clip" className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-xs" />}
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      From <Num value={it.start} onChange={(v) => setItem(i, { start: v })} /> to <Num value={it.end} onChange={(v) => setItem(i, { end: v })} />s
                      <span>({(it.end - it.start).toFixed(1)}s)</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-xs">↑</button>
                    <button onClick={() => move(i, 1)} disabled={i === n - 1} className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-xs">↓</button>
                    <button onClick={() => n > 2 && edit({ items: draft.items.filter((_, k) => k !== i) })} disabled={n <= 2} className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-red-900 disabled:opacity-30 text-xs">✕</button>
                  </div>
                </div>
              ))}
              <div className="flex gap-2 pt-2 border-t border-zinc-800">
                <select value={adding} onChange={(e) => setAdding(e.target.value)} className="flex-1 bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-sm">
                  <option value="">Add a clip from the library…</option>
                  {library.filter((l) => !draft.items.some((it) => it.key === l.key)).map((l) => <option key={l.key} value={l.key}>{l.title.slice(0, 70)} · {l.creator}</option>)}
                </select>
                <button onClick={addClip} disabled={!adding} className="px-3 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-sm">Add</button>
              </div>
            </div>

            <div className={card}>
              <h2 className="font-semibold">Options</h2>
              <div className="grid sm:grid-cols-2 gap-2">
                <Toggle label="Captions" checked={draft.options.captions} onChange={(v) => edit({ options: { ...draft.options, captions: v } })} />
                <Toggle label="Mask swear words in captions" checked={draft.options.cleanCaptions} onChange={(v) => edit({ options: { ...draft.options, cleanCaptions: v } })} />
                <Toggle label="Streamer name tags" checked={draft.options.nameCards} onChange={(v) => edit({ options: { ...draft.options, nameCards: v } })} />
                {short ? (
                  <Toggle label="Fill the screen (crop)" checked={draft.options.crop} onChange={(v) => edit({ options: { ...draft.options, crop: v } })} />
                ) : (
                  <Toggle label="Voiceover on the cards" checked={draft.options.voiceover} onChange={(v) => edit({ options: { ...draft.options, voiceover: v } })} />
                )}
              </div>
              {short ? (
                <label className="block text-sm space-y-1">
                  <span className="text-xs text-zinc-400">Hook (first 2.5 seconds)</span>
                  <input value={draft.hook} onChange={(e) => edit({ hook: e.target.value })} className={input} maxLength={120} />
                </label>
              ) : (
                <>
                  <label className="block text-sm space-y-1">
                    <span className="text-xs text-zinc-400">Intro voiceover</span>
                    <textarea value={draft.intro} onChange={(e) => edit({ intro: e.target.value })} rows={2} className={input} />
                  </label>
                  <label className="block text-sm space-y-1">
                    <span className="text-xs text-zinc-400">Outro voiceover</span>
                    <textarea value={draft.outro} onChange={(e) => edit({ outro: e.target.value })} rows={2} className={input} />
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    Voice <input value={draft.options.voice} onChange={(e) => edit({ options: { ...draft.options, voice: e.target.value } })} placeholder="default" className="w-32 bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1" />
                  </label>
                </>
              )}
              <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-800">
                <button onClick={() => run('script')} disabled={working} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-sm">↻ Rewrite the words</button>
                <button onClick={() => run('all')} disabled={working} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-sm">↻ Re-fit clips and rewrite</button>
              </div>
            </div>

            <div className={card}>
              <h2 className="font-semibold">Upload details</h2>
              {draft.titles.map((t, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input value={t} onChange={(e) => edit({ titles: draft.titles.map((x, k) => (k === i ? e.target.value : x)) })} className={input} maxLength={100} />
                  <span className={`text-xs w-8 text-right ${t.length > 70 ? 'text-amber-400' : 'text-zinc-500'}`}>{t.length}</span>
                  <button onClick={() => copy(t)} className="text-xs px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700">Copy</button>
                </div>
              ))}
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">Description (credits and hashtags are added below it)</span>
                <textarea value={draft.description} onChange={(e) => edit({ description: e.target.value })} rows={3} className={input} />
              </label>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Full description to paste{dirty ? ' (save to update)' : ''}</span>
                  <button onClick={() => copy(uploadDescription)} className="text-xs px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700">Copy</button>
                </div>
                <pre className="whitespace-pre-wrap text-xs bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-zinc-300">{uploadDescription}</pre>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Tags</span>
                  <button onClick={() => copy(draft.tags.join(', '))} className="text-xs px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700">Copy</button>
                </div>
                <input value={draft.tags.join(', ')} onChange={(e) => edit({ tags: e.target.value.split(',').map((t) => t.trimStart()) })} className={input} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
