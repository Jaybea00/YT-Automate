'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface ClipRow {
  id: string;
  sourceUrl: string;
  creator: string;
  title: string;
  status: string;
  step: string;
  error: string | null;
  createdAt: string;
  hasVideo: boolean;
  busy: boolean;
}

const STATUS_STYLE: Record<string, string> = {
  ready: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  failed: 'bg-red-500/15 text-red-300 border-red-500/30',
};
const isWorking = (c: ClipRow) => c.status !== 'ready' && c.status !== 'failed';

/** Clip-to-Short: paste a clip link, get a finished vertical Short and its upload details. */
export default function ClipsPage() {
  const router = useRouter();
  const [clips, setClips] = useState<ClipRow[] | null>(null);
  const [url, setUrl] = useState('');
  const [creator, setCreator] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchClips = useCallback(
    () => fetch('/api/clips', { cache: 'no-store' }).then((r) => r.json() as Promise<{ clips?: ClipRow[] }>).then((d) => d.clips ?? []),
    [],
  );
  const load = useCallback(() => fetchClips().then(setClips).catch(() => {}), [fetchClips]);

  useEffect(() => {
    let cancelled = false;
    fetchClips()
      .then((list) => {
        if (!cancelled) setClips(list);
      })
      .catch(() => {
        if (!cancelled) setClips([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchClips]);

  // Refresh while any clip is still being processed
  const working = clips?.some(isWorking) ?? false;
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
      const res = await fetch('/api/clips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, creator, note }) });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error || 'Could not start the clip');
      router.push(`/clips/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="flex gap-4 text-sm text-zinc-500">
              <Link href="/" className="hover:text-zinc-300">← Home</Link>
              <Link href="/hunts" className="hover:text-zinc-300">🎯 Stream Hunter</Link>
              <Link href="/moments" className="hover:text-zinc-300">🎞️ Compilations</Link>
            </div>
            <h1 className="text-2xl font-bold mt-1">✂️ Clip to Short</h1>
            <p className="text-sm text-zinc-400 mt-1">Paste a clip link (X, Twitch, YouTube, Kick, TikTok). You get a 9:16 Short with captions, hook and voiceover, plus titles and a description to upload yourself.</p>
          </div>
        </div>

        <form onSubmit={submit} className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-3">
          <label className="block text-sm font-semibold">Clip link</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://x.com/someone/status/123…"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-600"
            required
          />
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Credit (optional, defaults to the poster)</label>
              <input value={creator} onChange={(e) => setCreator(e.target.value)} placeholder="@creator" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">What happens (optional, improves the script)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="guy escapes 5 stars on a bicycle" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={submitting || !url.trim()}
            className="px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-semibold text-sm"
          >
            {submitting ? 'Starting…' : 'Make Short'}
          </button>
        </form>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">Clips</h2>
          {clips === null && <p className="text-sm text-zinc-500">Loading…</p>}
          {clips?.length === 0 && <p className="text-sm text-zinc-500">No clips yet.</p>}
          {clips?.map((c) => (
            <Link key={c.id} href={`/clips/${c.id}`} className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900 p-3">
              {c.hasVideo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/clips/${c.id}/file?name=thumbnail`} alt="" className="w-12 h-20 object-cover rounded-md bg-zinc-800 shrink-0" />
              ) : (
                <div className="w-12 h-20 rounded-md bg-zinc-800 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-sm truncate">{c.title}</p>
                <p className="text-xs text-zinc-500 truncate">{c.creator || c.sourceUrl}</p>
                {c.error && <p className="text-xs text-red-400 truncate">{c.error}</p>}
              </div>
              <span className={`text-xs px-2 py-1 rounded-full border shrink-0 ${STATUS_STYLE[c.status] ?? 'bg-amber-500/15 text-amber-300 border-amber-500/30'}`}>
                {c.status === 'ready' || c.status === 'failed' ? c.status : c.step}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
