'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface Queue {
  window: { start: string; end: string };
  items: Array<{ videoId: string; title: string; addedAt: string; lastError?: string | null }>;
  open?: boolean;
}

/**
 * Tonight's render queue: renders held during the day and started by the worker when the night
 * window opens, one after another, so the laptop stays free while you work.
 */
export default function OvernightPage() {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [start, setStart] = useState('23:00');
  const [end, setEnd] = useState('07:00');
  const [note, setNote] = useState<string | null>(null);

  const fetchQueue = useCallback(() => fetch('/api/overnight').then((r) => r.json()) as Promise<Queue>, []);
  const show = useCallback((q: Queue) => {
    setQueue(q);
    setStart(q.window.start);
    setEnd(q.window.end);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchQueue()
      .then((q) => {
        if (!cancelled) show(q);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchQueue, show]);

  async function post(body: unknown, done: string) {
    setNote(null);
    const res = await fetch('/api/overnight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return setNote(json.error || 'Something went wrong');
    setNote(done);
    show(await fetchQueue());
  }

  async function remove(videoId: string) {
    await fetch(`/api/overnight?videoId=${videoId}`, { method: 'DELETE' });
    show(await fetchQueue());
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div>
          <Link href="/" className="text-xs text-zinc-400 hover:text-zinc-200">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-bold text-white mt-1">Overnight renders</h1>
          <p className="text-xs text-zinc-400">
            Press 🌙 Render tonight on a video&apos;s progress page to hold its render here. When the window opens, the worker
            starts them one after another. Leave the worker running and the laptop awake.
          </p>
        </div>

        <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-zinc-400">Render between</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1" />
          <span className="text-zinc-400">and</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1" />
          <button onClick={() => post({ window: { start, end } }, 'Hours saved.')} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">
            Save hours
          </button>
          {queue && <span className={queue.open ? 'text-emerald-400' : 'text-zinc-500'}>{queue.open ? 'Open now' : 'Closed now'}</span>}
          <button
            onClick={() => post({ action: 'start' }, 'Started: they are queued for the worker now.')}
            disabled={!queue?.items.length}
            className="ml-auto px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium"
          >
            Start all now
          </button>
        </div>

        {note && <p className="text-xs text-zinc-300">{note}</p>}

        {queue === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : queue.items.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing held for tonight.</p>
        ) : (
          <ul className="space-y-2">
            {queue.items.map((item, i) => (
              <li key={item.videoId} className="p-3 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center gap-3 text-sm">
                <span className="text-zinc-500 w-5 text-right">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <Link href={`/videos/${item.videoId}/progress`} className="font-medium text-zinc-100 hover:underline truncate block">
                    {item.title}
                  </Link>
                  <p className="text-[11px] text-zinc-500">Added {new Date(item.addedAt).toLocaleString()}</p>
                  {item.lastError && <p className="text-[11px] text-red-300">Could not start: {item.lastError}</p>}
                </div>
                <button onClick={() => remove(item.videoId)} className="text-xs text-zinc-400 hover:text-red-300">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
