'use client';

import React, { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageContainer, EmptyState } from '@/components/ui/page';
import { ButtonLink } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { useRouter } from 'next/navigation';
import type { Hunt, Moment, RecipeId } from '@/pipeline/hunter/types';

const RECIPES: Array<{ id: RecipeId; label: string; emoji: string }> = [
  { id: 'funny', label: 'Funny', emoji: '😂' },
  { id: 'chase', label: 'Chase', emoji: '🚓' },
  { id: 'crash', label: 'Crash', emoji: '💥' },
  { id: 'clutch', label: 'Clutch', emoji: '🔥' },
  { id: 'rage', label: 'Rage', emoji: '😤' },
  { id: 'glitch', label: 'Glitch', emoji: '👾' },
  { id: 'other', label: 'Other', emoji: '🎬' },
];
const recipeOf = (id: RecipeId) => RECIPES.find((r) => r.id === id) ?? RECIPES[RECIPES.length - 1];

const clock = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
};
const STEPS = ['probing', 'listening', 'scanning', 'judging', 'cutting'];

/** One hunt: its moments, filterable by recipe, each one a click away from becoming a Short. */
export default function HuntPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [hunt, setHunt] = useState<Hunt | null>(null);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [filter, setFilter] = useState<RecipeId | 'all'>('all');
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  type Loaded = { hunt: Hunt; busy: boolean } | null;
  const fetchHunt = useCallback(async (): Promise<Loaded> => {
    const res = await fetch(`/api/hunts/${id}`, { cache: 'no-store' });
    return res.status === 404 ? null : ((await res.json()) as Loaded);
  }, [id]);
  const apply = useCallback((data: Loaded) => {
    if (!data) return setNotFound(true);
    setHunt(data.hunt);
    setBusy(data.busy);
  }, []);
  const load = useCallback(() => fetchHunt().then(apply).catch(() => {}), [fetchHunt, apply]);

  useEffect(() => {
    let cancelled = false;
    fetchHunt()
      .then((d) => {
        if (!cancelled) apply(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchHunt, apply]);

  const working = busy || (hunt !== null && hunt.status !== 'ready' && hunt.status !== 'failed');
  useEffect(() => {
    if (!working) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [working, load]);

  const patch = async (body: unknown) => {
    const res = await fetch(`/api/hunts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json()) as { hunt?: Hunt; error?: string };
    if (data.hunt) setHunt(data.hunt);
    else setError(data.error || 'Could not save');
  };

  const run = async (from: 'all' | 'cut') => {
    setError(null);
    const res = await fetch(`/api/hunts/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from }) });
    if (!res.ok) setError(((await res.json()) as { error?: string }).error || 'Could not start');
    await load();
  };

  const makeShort = async (m: Moment) => {
    if (m.clipId) return router.push(`/clips/${m.clipId}`);
    setSending(m.id);
    setError(null);
    const res = await fetch(`/api/hunts/${id}/moments/${m.id}/short`, { method: 'POST' });
    const data = (await res.json()) as { clipId?: string; error?: string };
    setSending(null);
    if (data.clipId) router.push(`/clips/${data.clipId}`);
    else setError(data.error || 'Could not make the Short');
  };

  const remove = async () => {
    if (!confirm('Delete this hunt and its cut moments? Shorts already made from it are kept.')) return;
    const res = await fetch(`/api/hunts/${id}`, { method: 'DELETE' });
    if (res.ok) router.push('/hunts');
    else setError(((await res.json()) as { error?: string }).error || 'Could not delete');
  };

  if (notFound) {
    return (
      <PageContainer>
        <EmptyState title="Hunt not found" action={<ButtonLink href="/hunts" icon="chevronLeft">Back to hunts</ButtonLink>} />
      </PageContainer>
    );
  }
  if (!hunt)
    return (
      <PageContainer>
        <EmptyState loading title="Loading the hunt…" />
      </PageContainer>
    );

  const visible = hunt.moments.filter((m) => (showDiscarded || !m.discarded) && (filter === 'all' || m.recipe === filter));
  const counts = new Map<RecipeId, number>();
  for (const m of hunt.moments) if (!m.discarded) counts.set(m.recipe, (counts.get(m.recipe) ?? 0) + 1);
  const failedCuts = hunt.moments.filter((m) => m.status === 'failed' && !m.discarded).length;
  const stepIndex = STEPS.indexOf(hunt.status);

  return (
    <PageContainer>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <Link href="/hunts" className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-200"><Icon name="chevronLeft" size={14} />Hunts</Link>
            <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-zinc-50 truncate">{hunt.title || 'New hunt'}</h1>
            <a href={hunt.pageUrl} target="_blank" rel="noreferrer" className="text-xs text-zinc-500 hover:text-zinc-300 break-all">
              {hunt.platform}{hunt.uploader ? ` · ${hunt.uploader}` : ''}{hunt.durationSec ? ` · ${clock(hunt.durationSec)}` : ''}
            </a>
            {hunt.status === 'ready' && (
              <p className="text-xs text-zinc-500 mt-1">
                Found from: sound{hunt.signals.chat ? `, ${hunt.signals.chat.toLocaleString()} chat messages${hunt.signals.uploadedChat ? ' (uploaded)' : ''}` : ''}{hunt.signals.captions ? ', YouTube captions' : ', Whisper'} · {hunt.candidates.length} stretches checked
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-zinc-400 flex items-center gap-2">
              Credit
              <input
                defaultValue={hunt.creator}
                placeholder={hunt.uploaderHandle || hunt.uploader || '@streamer'}
                onBlur={(e) => e.target.value !== hunt.creator && patch({ creator: e.target.value })}
                className="w-36 bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-sm text-zinc-200"
              />
            </label>
            <button onClick={remove} disabled={working} className="text-xs text-zinc-500 hover:text-red-400 disabled:opacity-40">Delete</button>
          </div>
        </div>

        {working && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200 space-y-2">
            <div>
              <span className="animate-pulse">●</span> {hunt.step}
              {stepIndex >= 0 && <span className="text-amber-200/60"> · step {stepIndex + 1} of {STEPS.length}</span>}
            </div>
            {hunt.progress != null && (
              <div className="h-1.5 rounded-full bg-amber-500/20 overflow-hidden">
                <div className="h-full bg-amber-400 transition-all" style={{ width: `${hunt.progress}%` }} />
              </div>
            )}
            <p className="text-xs text-amber-200/60">A few-hour stream usually takes 10–30 minutes. You can leave this page; the hunt keeps going.</p>
          </div>
        )}
        {hunt.status === 'failed' && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200 flex items-center justify-between gap-3 flex-wrap">
            <span>{hunt.error}</span>
            <button onClick={() => run('all')} className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold">Try again</button>
          </div>
        )}
        {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}
        {hunt.warnings.length > 0 && !working && (
          <ul className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-amber-300/90 space-y-1 list-disc pl-6">
            {hunt.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}

        {hunt.moments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setFilter('all')} className={`text-xs px-3 py-1.5 rounded-full border ${filter === 'all' ? 'bg-zinc-100 text-zinc-900 border-zinc-100' : 'border-zinc-700 text-zinc-300'}`}>
              All {hunt.moments.filter((m) => !m.discarded).length}
            </button>
            {RECIPES.filter((r) => counts.get(r.id)).map((r) => (
              <button key={r.id} onClick={() => setFilter(r.id)} className={`text-xs px-3 py-1.5 rounded-full border ${filter === r.id ? 'bg-zinc-100 text-zinc-900 border-zinc-100' : 'border-zinc-700 text-zinc-300'}`}>
                {r.emoji} {r.label} {counts.get(r.id)}
              </button>
            ))}
            <label className="text-xs text-zinc-500 flex items-center gap-1 ml-auto">
              <input type="checkbox" checked={showDiscarded} onChange={(e) => setShowDiscarded(e.target.checked)} /> Show hidden
            </label>
            {failedCuts > 0 && !working && (
              <button onClick={() => run('cut')} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700">Retry {failedCuts} failed cut{failedCuts > 1 ? 's' : ''}</button>
            )}
          </div>
        )}

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((m) => {
            const r = recipeOf(m.recipe);
            return (
              <div key={m.id} className={`rounded-2xl border border-zinc-800 bg-zinc-900/60 overflow-hidden flex flex-col ${m.discarded ? 'opacity-50' : ''}`}>
                {m.status === 'cut' ? (
                  <video src={`/api/hunts/${id}/file?moment=${m.id}`} poster={m.thumb ? `/api/hunts/${id}/file?moment=${m.id}&kind=thumb` : undefined} controls preload="none" className="w-full aspect-video bg-black" />
                ) : (
                  <div className="w-full aspect-video bg-zinc-900 flex items-center justify-center text-xs text-zinc-500 p-3 text-center">
                    {m.status === 'failed' ? `Could not cut: ${m.error ?? 'unknown error'}` : 'Waiting to be cut…'}
                  </div>
                )}
                <div className="p-3 space-y-2 flex-1 flex flex-col">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="px-2 py-0.5 rounded-full bg-zinc-800">{r.emoji} {r.label}</span>
                    <span className="text-zinc-500">{clock(m.start)}–{clock(m.end)} · {Math.round(m.end - m.start)}s</span>
                    <span className={`font-semibold ${m.score >= 8 ? 'text-emerald-400' : m.score >= 6 ? 'text-amber-300' : 'text-zinc-400'}`}>{m.score}/10</span>
                  </div>
                  {m.hook && <p className="text-sm font-semibold">“{m.hook}”</p>}
                  <p className="text-xs text-zinc-400 flex-1">{m.reason}</p>
                  {m.chatSample.length > 0 && <p className="text-[11px] text-zinc-500 truncate" title={m.chatSample.join('\n')}>💬 {m.chatSample.slice(0, 4).join(' · ')}</p>}
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => makeShort(m)}
                      disabled={m.status !== 'cut' || sending === m.id}
                      className="flex-1 px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white font-semibold text-xs"
                    >
                      {m.clipId ? 'Open Short →' : sending === m.id ? 'Starting…' : 'Make Short'}
                    </button>
                    {m.status === 'cut' && (
                      <a href={`/api/hunts/${id}/file?moment=${m.id}&download=1`} className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs" title="Download the raw clip">⬇</a>
                    )}
                    <button onClick={() => patch({ discard: { [m.id]: !m.discarded } })} className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs" title={m.discarded ? 'Bring back' : 'Hide'}>
                      {m.discarded ? '↺' : '✕'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {hunt.status === 'ready' && visible.length === 0 && <p className="text-sm text-zinc-500">No moments here.</p>}
    </PageContainer>
  );
}
