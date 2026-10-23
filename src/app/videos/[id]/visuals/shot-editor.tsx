'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { ShotAlternative } from '@/pipeline/visuals/shot-composer';

interface EditorShot {
  index: number;
  plannedType: string;
  renderedType: string;
  startSec: number;
  durationSec: number;
  sourceUrl?: string | null;
  license?: string | null;
  attribution?: string | null;
  note?: string;
  error?: string;
  /** The relevance check was unavailable when this shot was picked: pick again once it's back. */
  needsCheck?: boolean;
  alternatives?: ShotAlternative[];
  plan: { visual_query: string; covers: string };
}

const TYPE_LABEL: Record<string, { label: string; bar: string }> = {
  stock: { label: 'Stock', bar: 'bg-zinc-500' },
  archive: { label: 'Archive', bar: 'bg-orange-500/80' },
  chart: { label: 'Chart', bar: 'bg-emerald-500/80' },
  stat: { label: 'Stat', bar: 'bg-teal-400/80' },
  quote: { label: 'Quote', bar: 'bg-fuchsia-500/70' },
  geo_map: { label: 'Map', bar: 'bg-blue-500/80' },
  newspaper: { label: 'Newspaper', bar: 'bg-amber-500/80' },
  screen_recording: { label: 'Screen', bar: 'bg-indigo-500/80' },
  timeline: { label: 'Timeline', bar: 'bg-cyan-500/80' },
  comparison: { label: 'Compare', bar: 'bg-lime-500/80' },
  title: { label: 'Title', bar: 'bg-rose-500/80' },
  kinetic_text: { label: 'Text', bar: 'bg-violet-500/80' },
  diagram: { label: 'Diagram', bar: 'bg-sky-400/80' },
  color: { label: 'Blank', bar: 'bg-red-600/80' },
};
const typeLabel = (t: string) => TYPE_LABEL[t]?.label ?? t;

type Edit = { action: 'swap'; candidate: ShotAlternative } | { action: 'redo' } | { action: 'text' };

/**
 * The shots a composed beat is cut from, each previewable and replaceable on its own: swap to an
 * alternative that passed the relevance check, search with your own words, pick again, or show
 * the narration as type. Only the edited shot re-renders; the rest of the beat is untouched.
 */
export function ShotEditor({ videoId, beatIndex, onChanged }: { videoId: string; beatIndex: number; onChanged: () => void }) {
  const [shots, setShots] = useState<EditorShot[] | null>(null);
  const [editable, setEditable] = useState(false);
  const [busy, setBusy] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<Record<number, 'alternatives' | 'search' | null>>({});
  const [queries, setQueries] = useState<Record<number, string>>({});
  const [results, setResults] = useState<Record<number, ShotAlternative[]>>({});
  const [versions, setVersions] = useState<Record<number, number>>({});

  const base = `/api/videos/${videoId}/beats/${beatIndex}/shots`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(base);
      const body = await res.json();
      setEditable(Boolean(body.editable));
      setShots(body.shots ?? []);
    } catch {
      setShots([]);
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  const apply = async (shotIndex: number, edit: Edit, message: string) => {
    setBusy((b) => ({ ...b, [shotIndex]: message }));
    setErrors((e) => ({ ...e, [shotIndex]: '' }));
    try {
      const res = await fetch(`${base}/${shotIndex}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edit),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'The shot could not be replaced');
      setShots((prev) => prev?.map((s) => (s.index === shotIndex ? body.shot : s)) ?? prev);
      setVersions((v) => ({ ...v, [shotIndex]: Date.now() }));
      setOpen((o) => ({ ...o, [shotIndex]: null }));
      onChanged();
    } catch (err) {
      setErrors((e) => ({ ...e, [shotIndex]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[shotIndex];
        return next;
      });
    }
  };

  // Your own photo or clip into just this shot; the beat's other shots stay as they are
  const upload = async (shotIndex: number, file: File) => {
    setBusy((b) => ({ ...b, [shotIndex]: `Uploading ${file.name} and fitting it to the shot…` }));
    setErrors((e) => ({ ...e, [shotIndex]: '' }));
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('license_type', 'own_work');
      const res = await fetch(`${base}/${shotIndex}/upload`, { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'The upload could not be used');
      setShots((prev) => prev?.map((s) => (s.index === shotIndex ? body.shot : s)) ?? prev);
      setVersions((v) => ({ ...v, [shotIndex]: Date.now() }));
      onChanged();
    } catch (err) {
      setErrors((e) => ({ ...e, [shotIndex]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[shotIndex];
        return next;
      });
    }
  };

  const search = async (shotIndex: number) => {
    const query = (queries[shotIndex] ?? '').trim();
    if (query.length < 2) return;
    setBusy((b) => ({ ...b, [shotIndex]: 'Searching archives and stock…' }));
    setErrors((e) => ({ ...e, [shotIndex]: '' }));
    try {
      const res = await fetch(`${base}/${shotIndex}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Search failed');
      setResults((r) => ({ ...r, [shotIndex]: body.results ?? [] }));
    } catch (err) {
      setErrors((e) => ({ ...e, [shotIndex]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[shotIndex];
        return next;
      });
    }
  };

  if (shots === null) {
    return <div className="text-xs text-zinc-500 italic">Loading shots…</div>;
  }
  if (!editable || shots.length === 0) return null;

  const total = shots.reduce((n, s) => n + s.durationSec, 0) || 1;

  return (
    <div className="bg-zinc-950/70 p-4 rounded-xl border border-zinc-800 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-zinc-200 text-xs uppercase tracking-wider">🎞️ Shots ({shots.length})</span>
        <span className="text-[11px] text-zinc-500">Each shot can be replaced on its own; the cuts stay on the narration.</span>
      </div>

      {/* Timeline strip: each shot's share of the beat */}
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-900 gap-0.5" aria-hidden>
        {shots.map((s) => (
          <div
            key={s.index}
            className={TYPE_LABEL[s.renderedType]?.bar ?? 'bg-zinc-600'}
            style={{ width: `${(s.durationSec / total) * 100}%` }}
            title={`${typeLabel(s.renderedType)} · ${s.durationSec.toFixed(1)}s`}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {shots.map((s) => {
          const isBusy = busy[s.index];
          const fellBack = s.renderedType !== s.plannedType && !(s.plannedType === 'archive' && s.renderedType === 'stock');
          const pool = open[s.index] === 'search' ? results[s.index] ?? [] : s.alternatives ?? [];
          const isFootage = s.renderedType === 'stock' || s.renderedType === 'archive' || s.plannedType === 'stock' || s.plannedType === 'archive';
          // Same rule as shotNeedsCheck: flagged, or picked by title alone by older renders
          const unchecked = Boolean(s.needsCheck) || ((s.renderedType === 'stock' || s.renderedType === 'archive') && /unchecked relevance/.test(s.note ?? ''));
          return (
            <div key={s.index} className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden flex flex-col">
              <div className="relative aspect-video bg-black">
                <video
                  key={versions[s.index] ?? 0}
                  src={`${base}/${s.index}?v=${versions[s.index] ?? 0}`}
                  className="w-full h-full object-contain"
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                  onMouseLeave={(e) => e.currentTarget.pause()}
                />
                <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-black/80 text-zinc-200">
                  #{s.index + 1} · {s.startSec.toFixed(1)}s · {s.durationSec.toFixed(1)}s
                </span>
                <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-black/80 text-zinc-200">
                  {typeLabel(s.renderedType)}
                </span>
                {unchecked && (
                  <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/90 text-black">
                    Needs check
                  </span>
                )}
                {isBusy && (
                  <div className="absolute inset-0 bg-black/70 flex items-center justify-center text-xs text-zinc-200 text-center px-4">
                    {isBusy}
                  </div>
                )}
              </div>

              <div className="p-3 space-y-2 text-[11px] flex-1 flex flex-col">
                <p className="text-zinc-300">&ldquo;{s.plan.covers}&rdquo;</p>
                <p className="text-zinc-500 font-mono">{s.plan.visual_query}</p>
                {fellBack && (
                  <p className="text-amber-300">Planned as {typeLabel(s.plannedType)}, shown as {typeLabel(s.renderedType)}.</p>
                )}
                {unchecked && (
                  <p className="text-amber-300">
                    Footage couldn&apos;t be checked for relevance when this was made (usually the Gemini limit). Use Find another once it has reset.
                  </p>
                )}
                {s.note && <p className="text-zinc-400">{s.note}</p>}
                {s.error && <p className="text-red-400">Render failed: {s.error}</p>}
                {s.sourceUrl && /^https?:/.test(s.sourceUrl) && (
                  <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300 truncate block">
                    Source ({s.license ?? 'license unknown'})
                  </a>
                )}
                {errors[s.index] && <p className="text-red-400">{errors[s.index]}</p>}

                <div className="flex flex-wrap gap-1.5 pt-1 mt-auto">
                  {isFootage && (
                    <button
                      type="button"
                      disabled={Boolean(isBusy)}
                      onClick={() => setOpen((o) => ({ ...o, [s.index]: o[s.index] === 'alternatives' ? null : 'alternatives' }))}
                      className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 disabled:opacity-50"
                    >
                      Alternatives ({s.alternatives?.length ?? 0})
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={Boolean(isBusy)}
                    onClick={() => setOpen((o) => ({ ...o, [s.index]: o[s.index] === 'search' ? null : 'search' }))}
                    className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 disabled:opacity-50"
                  >
                    Search…
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(isBusy)}
                    onClick={() => apply(s.index, { action: 'redo' }, 'Picking again… (up to a minute)')}
                    className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 disabled:opacity-50"
                    title={isFootage ? 'Find different footage' : 'Render this graphic again'}
                  >
                    {isFootage ? 'Find another' : 'Re-render'}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(isBusy)}
                    onClick={() => apply(s.index, { action: 'text' }, 'Setting the narration as type…')}
                    className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 disabled:opacity-50"
                  >
                    Text card
                  </button>
                  <label
                    className={`px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 ${isBusy ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}
                    title="Use your own photo or clip for this shot only (your own work; for licensed footage use the beat upload)"
                  >
                    Upload your own
                    <input
                      type="file"
                      accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) upload(s.index, file);
                      }}
                    />
                  </label>
                </div>

                {open[s.index] === 'search' && (
                  <div className="flex gap-1.5 pt-1">
                    <input
                      type="text"
                      value={queries[s.index] ?? ''}
                      placeholder={s.plan.visual_query}
                      onChange={(e) => setQueries((q) => ({ ...q, [s.index]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          search(s.index);
                        }
                      }}
                      className="flex-1 px-2 py-1 rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                    />
                    <button
                      type="button"
                      disabled={Boolean(isBusy)}
                      onClick={() => search(s.index)}
                      className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
                    >
                      Search
                    </button>
                  </div>
                )}

                {open[s.index] && (
                  pool.length > 0 ? (
                    <div className="grid grid-cols-3 gap-1.5 pt-1">
                      {pool.map((alt) => (
                        <button
                          key={`${alt.provider}-${alt.id}`}
                          type="button"
                          disabled={Boolean(isBusy)}
                          onClick={() => apply(s.index, { action: 'swap', candidate: alt }, 'Rendering your pick…')}
                          className="group relative aspect-video rounded-md overflow-hidden border border-zinc-800 hover:border-indigo-500 bg-zinc-950 disabled:opacity-50"
                          title={alt.title}
                        >
                          {alt.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={alt.thumbnailUrl} alt={alt.title ?? 'Alternative'} className="w-full h-full object-cover" />
                          ) : (
                            <span className="text-zinc-600 text-[10px]">No preview</span>
                          )}
                          <span className="absolute bottom-0.5 left-0.5 px-1 rounded text-[9px] bg-black/80 text-zinc-300">
                            {alt.provider}
                            {alt.mediaType === 'video' ? ' ▶' : ''}
                          </span>
                          {alt.score !== undefined && (
                            <span
                              className={`absolute top-0.5 right-0.5 px-1 rounded text-[9px] font-bold bg-black/80 ${
                                alt.score >= 6 ? 'text-emerald-300' : 'text-amber-300'
                              }`}
                            >
                              {alt.score}/10
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-zinc-500 italic pt-1">
                      {open[s.index] === 'search' ? 'Search to see results.' : 'No other candidates passed the relevance check.'}
                    </p>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
