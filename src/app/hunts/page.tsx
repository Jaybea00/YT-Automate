'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface HuntRow {
  id: string;
  url: string;
  platform: string;
  title: string;
  uploader: string;
  durationSec: number;
  status: string;
  step: string;
  progress: number | null;
  error: string | null;
  createdAt: string;
  moments: number;
  thumb: { moment: string } | null;
  busy: boolean;
}

const hours = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)}m`);
const isWorking = (h: HuntRow) => h.status !== 'ready' && h.status !== 'failed';

/** Stream hunter: paste a finished stream, get its best moments as clips ready for the Short editor. */
export default function HuntsPage() {
  const router = useRouter();
  const [hunts, setHunts] = useState<HuntRow[] | null>(null);
  const [url, setUrl] = useState('');
  const [creator, setCreator] = useState('');
  const [maxMoments, setMaxMoments] = useState(12);
  const [chat, setChat] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHunts = useCallback(
    () => fetch('/api/hunts', { cache: 'no-store' }).then((r) => r.json() as Promise<{ hunts?: HuntRow[] }>).then((d) => d.hunts ?? []),
    [],
  );
  const load = useCallback(() => fetchHunts().then(setHunts).catch(() => {}), [fetchHunts]);

  useEffect(() => {
    let cancelled = false;
    fetchHunts()
      .then((list) => {
        if (!cancelled) setHunts(list);
      })
      .catch(() => {
        if (!cancelled) setHunts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchHunts]);

  const working = hunts?.some(isWorking) ?? false;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [working, load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('url', url);
      form.set('creator', creator);
      form.set('maxMoments', String(maxMoments));
      if (chat) form.set('chat', chat);
      const res = await fetch('/api/hunts', { method: 'POST', body: form });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error || 'Could not start the hunt');
      router.push(`/hunts/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        <div>
          <div className="flex gap-4 text-sm text-zinc-500">
            <Link href="/" className="hover:text-zinc-300">← Home</Link>
            <Link href="/clips" className="hover:text-zinc-300">✂️ Clip to Short</Link>
            <Link href="/moments" className="hover:text-zinc-300">🎞️ Compilations</Link>
          </div>
          <h1 className="text-2xl font-bold mt-1">🎯 Stream Hunter</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Paste a finished stream (YouTube, Twitch or Kick). The hunter listens to the sound, reads the chat and captions where it can, picks the best moments and cuts them out. Send any moment to the Short editor with one click.
          </p>
        </div>

        <form onSubmit={submit} className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-3">
          <label className="block text-sm font-semibold">Stream link</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=… or https://www.twitch.tv/videos/…"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-600"
            required
          />
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Credit (optional, defaults to the channel)</label>
              <input value={creator} onChange={(e) => setCreator(e.target.value)} placeholder="@streamer" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Most moments to keep</label>
              <select value={maxMoments} onChange={(e) => setMaxMoments(Number(e.target.value))} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm">
                {[6, 12, 20, 30].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Chat log (optional, Twitch/Kick)</label>
              <input type="file" accept=".json,application/json" onChange={(e) => setChat(e.target.files?.[0] ?? null)} className="w-full text-xs text-zinc-400 file:mr-2 file:rounded-md file:border-0 file:bg-zinc-800 file:px-2 file:py-1.5 file:text-zinc-200" />
            </div>
          </div>
          <p className="text-xs text-zinc-500">YouTube chat replay and captions are fetched automatically. For Twitch or Kick, a chat JSON exported with TwitchDownloader makes the hunt better (optional).</p>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button type="submit" disabled={submitting || !url.trim()} className="px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-semibold text-sm">
            {submitting ? 'Starting…' : 'Hunt this stream'}
          </button>
        </form>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">Hunts</h2>
          {hunts === null && <p className="text-sm text-zinc-500">Loading…</p>}
          {hunts?.length === 0 && <p className="text-sm text-zinc-500">No hunts yet.</p>}
          {hunts?.map((h) => (
            <Link key={h.id} href={`/hunts/${h.id}`} className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900 p-3">
              {h.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/hunts/${h.id}/file?moment=${h.thumb.moment}&kind=thumb`} alt="" className="w-28 h-16 object-cover rounded-md bg-zinc-800 shrink-0" />
              ) : (
                <div className="w-28 h-16 rounded-md bg-zinc-800 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-sm truncate">{h.title}</p>
                <p className="text-xs text-zinc-500 truncate">
                  {h.platform}{h.uploader ? ` · ${h.uploader}` : ''}{h.durationSec ? ` · ${hours(h.durationSec)}` : ''}{h.status === 'ready' ? ` · ${h.moments} moments` : ''}
                </p>
                {h.error && <p className="text-xs text-red-400 truncate">{h.error}</p>}
              </div>
              <span
                className={`text-xs px-2 py-1 rounded-full border shrink-0 max-w-56 truncate ${
                  h.status === 'ready' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : h.status === 'failed' ? 'bg-red-500/15 text-red-300 border-red-500/30' : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                }`}
              >
                {h.status === 'ready' || h.status === 'failed' ? h.status : h.step}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
