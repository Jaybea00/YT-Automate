'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageContainer, PageHeader } from '@/components/ui/page';
import { useRouter } from 'next/navigation';

interface Item {
  key: string;
  kind: 'moment' | 'clip';
  title: string;
  description: string;
  recipe: string;
  score: number | null;
  creator: string;
  platform: string;
  pageUrl: string;
  durationSec: number;
  hasThumb: boolean;
  usedIn: string[];
  createdAt: string;
}
interface Theme {
  name: string;
  filter: { recipes?: string[]; creator?: string; unusedOnly?: boolean };
  available: number;
}
interface CompRow {
  id: string;
  format: 'short' | 'long';
  title: string;
  clips: number;
  status: string;
  step: string;
  error: string | null;
  durationSec: number | null;
  hasVideo: boolean;
}

const RECIPES: Record<string, string> = { funny: '😂 Funny', chase: '🚓 Chase', crash: '💥 Crash', clutch: '🔥 Clutch', rage: '😤 Rage', glitch: '👾 Glitch', other: '🎬 Other' };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** The moments library (hunted moments + clips) and the compilations made from it. */
export default function MomentsPage() {
  const router = useRouter();
  const [items, setItems] = useState<Item[] | null>(null);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [comps, setComps] = useState<CompRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [recipe, setRecipe] = useState('all');
  const [creator, setCreator] = useState('all');
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    const [m, c] = await Promise.all([
      fetch('/api/moments', { cache: 'no-store' }).then((r) => r.json() as Promise<{ items: Item[]; themes: Theme[] }>),
      fetch('/api/compilations', { cache: 'no-store' }).then((r) => r.json() as Promise<{ compilations: CompRow[] }>),
    ]);
    return { ...m, comps: c.compilations };
  }, []);
  const apply = useCallback((d: Awaited<ReturnType<typeof fetchAll>>) => {
    setItems(d.items);
    setThemes(d.themes);
    setComps(d.comps);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then((d) => {
        if (!cancelled) apply(d);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchAll, apply]);

  const working = comps.some((c) => c.status !== 'ready' && c.status !== 'failed' && c.status !== 'draft');
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => fetchAll().then(apply).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [working, fetchAll, apply]);

  const creators = useMemo(() => [...new Set((items ?? []).map((i) => i.creator).filter(Boolean))].sort(), [items]);
  const visible = (items ?? []).filter((i) => (recipe === 'all' || i.recipe === recipe) && (creator === 'all' || i.creator === creator) && (!unusedOnly || !i.usedIn.length));

  const start = async (body: Record<string, unknown>) => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/compilations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!data.id) throw new Error(data.error || 'Could not start the compilation');
      router.push(`/compilations/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  };
  const toggle = (key: string) => setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  return (
    <div className="pb-24">
      <PageContainer>
        <PageHeader
          eyebrow="Compilations"
          title="Moments and compilations"
          description="Every moment from your hunts and every clip you made from a link. Pick a theme, or tick clips, to make a compilation."
        />

        {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}

        {themes.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">Make a compilation from a theme</h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {themes.map((t) => (
                <div key={t.name} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
                  <p className="font-semibold text-sm">{t.name}</p>
                  <p className="text-xs text-zinc-500">{t.available} unused clips fit</p>
                  <div className="flex gap-2">
                    <button disabled={starting} onClick={() => start({ format: 'short', theme: t.filter, title: t.name })} className="flex-1 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-xs font-semibold">
                      Short ({Math.min(4, t.available)} clips)
                    </button>
                    <button disabled={starting} onClick={() => start({ format: 'long', theme: t.filter, title: t.name, count: Math.min(15, t.available) })} className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-semibold">
                      Countdown ({Math.min(15, t.available)} clips)
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {comps.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">Compilations</h2>
            {comps.map((c) => (
              <Link key={c.id} href={`/compilations/${c.id}`} className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900 p-3">
                {c.hasVideo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/compilations/${c.id}/file?name=thumbnail`} alt="" className={`${c.format === 'short' ? 'w-10 h-16' : 'w-28 h-16'} object-cover rounded-md bg-zinc-800 shrink-0`} />
                ) : (
                  <div className={`${c.format === 'short' ? 'w-10 h-16' : 'w-28 h-16'} rounded-md bg-zinc-800 shrink-0`} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm truncate">{c.title}</p>
                  <p className="text-xs text-zinc-500">{c.format === 'short' ? 'Short' : 'Countdown'} · {c.clips} clips{c.durationSec ? ` · ${mmss(c.durationSec)}` : ''}</p>
                  {c.error && <p className="text-xs text-red-400 truncate">{c.error}</p>}
                </div>
                <span className={`text-xs px-2 py-1 rounded-full border shrink-0 max-w-56 truncate ${c.status === 'ready' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : c.status === 'failed' ? 'bg-red-500/15 text-red-300 border-red-500/30' : 'bg-amber-500/15 text-amber-300 border-amber-500/30'}`}>
                  {c.status === 'ready' || c.status === 'failed' ? c.status : c.step}
                </span>
              </Link>
            ))}
          </div>
        )}

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mr-auto">All moments {items ? `(${visible.length})` : ''}</h2>
            <select value={recipe} onChange={(e) => setRecipe(e.target.value)} className="bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1 text-sm">
              <option value="all">All kinds</option>
              {Object.entries(RECIPES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <select value={creator} onChange={(e) => setCreator(e.target.value)} className="bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1 text-sm">
              <option value="all">All streamers</option>
              {creators.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label className="text-sm text-zinc-400 flex items-center gap-1">
              <input type="checkbox" checked={unusedOnly} onChange={(e) => setUnusedOnly(e.target.checked)} /> Unused only
            </label>
          </div>
          {items === null && <p className="text-sm text-zinc-500">Loading…</p>}
          {items?.length === 0 && (
            <p className="text-sm text-zinc-500">
              Nothing yet. <Link href="/hunts" className="underline">Hunt a stream</Link> or <Link href="/clips" className="underline">make a clip from a link</Link>.
            </p>
          )}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {visible.map((i) => {
              const on = selected.includes(i.key);
              return (
                <button key={i.key} onClick={() => toggle(i.key)} className={`text-left rounded-xl border overflow-hidden bg-zinc-900/60 ${on ? 'border-red-500 ring-2 ring-red-500/40' : 'border-zinc-800 hover:border-zinc-600'}`}>
                  <div className="relative aspect-video bg-zinc-800">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {i.hasThumb && <img src={`/api/moments/media?key=${encodeURIComponent(i.key)}&kind=thumb`} alt="" className="w-full h-full object-cover" />}
                    <span className="absolute top-1.5 left-1.5 text-[11px] px-1.5 py-0.5 rounded bg-black/70">{RECIPES[i.recipe] ?? i.recipe}</span>
                    <span className="absolute bottom-1.5 right-1.5 text-[11px] px-1.5 py-0.5 rounded bg-black/70">{mmss(i.durationSec)}</span>
                    {on && <span className="absolute top-1.5 right-1.5 text-xs px-1.5 py-0.5 rounded bg-red-600 font-bold">#{selected.indexOf(i.key) + 1}</span>}
                  </div>
                  <div className="p-2 space-y-0.5">
                    <p className="text-sm font-medium line-clamp-2">{i.title}</p>
                    <p className="text-xs text-zinc-500 truncate">
                      {i.creator || i.platform}
                      {i.score != null ? ` · ${i.score}/10` : ' · from a link'}
                      {i.usedIn.length ? ` · used ${i.usedIn.length}×` : ''}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </PageContainer>

      {selected.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-3">
          <div className="max-w-6xl mx-auto flex flex-wrap items-center gap-3">
            <span className="text-sm">{selected.length} selected</span>
            <button onClick={() => setSelected([])} className="text-xs text-zinc-400 hover:text-zinc-200">Clear</button>
            <span className="ml-auto" />
            <button disabled={starting || selected.length < 2 || selected.length > 6} onClick={() => start({ format: 'short', keys: selected })} className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-sm font-semibold" title="2-6 clips">
              Make a Short
            </button>
            <button disabled={starting || selected.length < 2} onClick={() => start({ format: 'long', keys: selected })} className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-sm font-semibold">
              Make a countdown
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
