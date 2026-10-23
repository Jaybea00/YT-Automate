'use client';

import React, { useEffect, useRef, useState } from 'react';

interface Preview {
  renderedAt: string | null;
  error: string | null;
  only?: number[];
}

/**
 * "Preview this beat": a small, fast render of just this beat with its captions, music and sound
 * effects, without assembling the whole video. Uses the quick-preview render; the final render
 * reuses its scene.
 */
export function BeatPreviewButton({ videoId, beatIndex, preview }: { videoId: string; beatIndex: number; preview: Preview | null }) {
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  const showsThisBeat = preview?.renderedAt && preview.only?.length === 1 && preview.only[0] === beatIndex;

  async function start() {
    setError(null);
    // Whatever the preview record says now; the next change to it is this render finishing
    const since = JSON.stringify(preview ?? null);
    const res = await fetch(`/api/videos/${videoId}/assembly`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: true, beats: [beatIndex] }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error || 'Could not start the preview');
    setWaiting('Rendering this beat…');
    timer.current = setInterval(async () => {
      const p = await fetch(`/api/videos/${videoId}/progress`).then((r) => r.json()).catch(() => null);
      const next: Preview | undefined = p?.video?.script_json?.preview;
      if (!next || JSON.stringify(next) === since) return;
      stop();
      if (next.renderedAt) setOpen(next.renderedAt);
      else setError(next.error || 'The preview failed');
    }, 3000);
  }

  function stop() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setWaiting(null);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => (showsThisBeat && !waiting ? setOpen(preview!.renderedAt) : start())}
        disabled={Boolean(waiting)}
        title="A quick render of just this beat, with captions, music and sound effects"
        className="px-2 py-1 rounded-lg text-[11px] bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 disabled:opacity-50"
      >
        {waiting ? '⏳ Rendering…' : showsThisBeat ? '⚡ Watch preview' : '⚡ Preview beat'}
      </button>
      {showsThisBeat && !waiting && (
        <button type="button" onClick={start} title="Render the preview again" className="text-[11px] text-zinc-500 hover:text-zinc-200">
          ↻
        </button>
      )}
      {error && <span className="text-[11px] text-red-300 max-w-48 truncate" title={error}>{error}</span>}
      {open && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setOpen(null)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-4 w-full max-w-3xl space-y-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white">⚡ Beat #{beatIndex + 1} preview</h2>
              <button onClick={() => setOpen(null)} className="text-zinc-400 hover:text-white text-sm">
                ✕
              </button>
            </div>
            <video src={`/api/videos/${videoId}/render?preview=1&v=${encodeURIComponent(open)}`} controls autoPlay className="w-full rounded-lg bg-black" />
            <p className="text-[11px] text-zinc-500">Small and fast: the music starts from its beginning here, and the transitions into and out of the beat aren&apos;t shown.</p>
          </div>
        </div>
      )}
    </>
  );
}
