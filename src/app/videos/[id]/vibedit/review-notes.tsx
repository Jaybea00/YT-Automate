'use client';

import React, { useCallback, useEffect, useState } from 'react';

interface Note {
  id: string;
  atSec: number;
  beat: number;
  text: string;
  resolved: boolean;
  source?: 'ai';
  kind?: string;
  severity?: 'high' | 'medium' | 'low';
}

interface WatchStatus {
  state: 'preparing' | 'uploading' | 'watching' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  renderedAt?: string;
  notes?: number;
  summary?: string;
  error?: string;
}

/** What each kind of AI note is about (mirrors watch-through.ts). */
const KIND_LABEL: Record<string, string> = {
  caption: 'Captions',
  picture_mismatch: 'Picture vs words',
  pacing: 'Pacing',
  sound: 'Sound',
  glitch: 'Glitch',
  on_screen_text: 'On-screen text',
  repetition: 'Repetition',
  opening: 'Opening',
};
const SEVERITY_CLASS = { high: 'bg-red-950 text-red-300 border-red-900', medium: 'bg-amber-950 text-amber-300 border-amber-900', low: 'bg-zinc-800 text-zinc-400 border-zinc-700' };
const WATCH_STEP: Record<string, string> = {
  preparing: 'Making a small copy of the video…',
  uploading: 'Sending it to Gemini…',
  watching: 'Gemini is watching the video (a few minutes for a long one)…',
};
const watching = (s: WatchStatus | null) => Boolean(s && ['preparing', 'uploading', 'watching'].includes(s.state));

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * Review notes pinned to moments: markers along the scrubber, a box to pin a note at the
 * playhead, and the list to work through (click to jump there, tick when dealt with).
 */
export function ReviewNotes({
  videoId,
  currentSec,
  totalSec,
  activeBeat,
  onSeek,
}: {
  videoId: string;
  currentSec: number;
  totalSec: number;
  activeBeat: number;
  onSeek: (note: { atSec: number; beat: number }) => void;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watch, setWatch] = useState<WatchStatus | null>(null);
  /** Bumped when a watch-through starts, so its progress is followed. */
  const [watchRun, setWatchRun] = useState(0);

  const fetchNotes = useCallback(() => fetch(`/api/videos/${videoId}/vibedit/notes`).then((r) => r.json()) as Promise<{ notes?: Note[] }>, [videoId]);
  useEffect(() => {
    let cancelled = false;
    fetchNotes()
      .then((b) => {
        if (!cancelled) setNotes(b.notes ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchNotes]);

  // The AI watch-through: its last result, and progress while one runs (then its notes)
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wasWatching = false;
    const poll = () =>
      fetch(`/api/videos/${videoId}/vibedit/watch`)
        .then((r) => r.json() as Promise<{ status?: WatchStatus | null }>)
        .then(async (b) => {
          if (cancelled) return;
          const s = b.status ?? null;
          setWatch(s);
          if (watching(s)) {
            wasWatching = true;
            timer = setTimeout(poll, 4000);
          } else if (wasWatching && s?.state === 'done') {
            const n = await fetchNotes();
            if (!cancelled) setNotes(n.notes ?? []);
          }
        })
        .catch(() => {});
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [videoId, fetchNotes, watchRun]);

  async function startWatch() {
    setError(null);
    const res = await fetch(`/api/videos/${videoId}/vibedit/watch`, { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return setError(json.error || 'Could not start the watch-through');
    setWatch(json.status);
    setWatchRun((n) => n + 1);
  }

  async function call(method: string, body?: unknown, query = '') {
    setError(null);
    const res = await fetch(`/api/videos/${videoId}/vibedit/notes${query}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return setError(json.error || 'Could not save the note');
    setNotes(json.notes ?? []);
    return true;
  }

  const open = notes.filter((n) => !n.resolved);
  const listed = showResolved ? notes : open;

  return (
    <div className="space-y-2">
      {/* Markers along the scrubber */}
      {totalSec > 0 && (
        <div className="relative h-3">
          {notes.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => onSeek(n)}
              title={`${clock(n.atSec)}: ${n.text}`}
              style={{ left: `${Math.min(100, (n.atSec / totalSec) * 100)}%` }}
              className={`absolute -translate-x-1/2 top-0 text-[10px] leading-none ${n.resolved ? 'opacity-30' : ''}`}
            >
              {n.source === 'ai' ? '🤖' : '📌'}
            </button>
          ))}
        </div>
      )}

      {/* The AI watch-through */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-zinc-400">
            {watching(watch)
              ? WATCH_STEP[watch!.state]
              : watch?.state === 'done'
                ? `AI watched the render of ${watch.renderedAt ? new Date(watch.renderedAt).toLocaleString() : 'this video'}: ${watch.notes ?? 0} note${watch.notes === 1 ? '' : 's'}.`
                : watch?.state === 'failed'
                  ? `The last watch-through failed: ${watch.error ?? 'unknown error'}`
                  : 'Have Gemini watch the finished video and pin notes where something needs fixing.'}
          </span>
          <button
            type="button"
            onClick={startWatch}
            disabled={watching(watch)}
            className="shrink-0 px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold"
          >
            {watching(watch) ? 'Watching…' : watch?.state === 'done' ? 'Watch again' : '👁 AI watch-through'}
          </button>
        </div>
        {watch?.state === 'done' && watch.summary && <p className="text-zinc-500 italic">{watch.summary}</p>}
      </div>

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call('POST', { atSec: currentSec, beat: activeBeat, text })) setText('');
        }}
        className="flex gap-2"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Note at ${clock(currentSec)} (beat ${activeBeat + 1})…`}
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100"
        />
        <button type="submit" disabled={!text.trim()} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40 text-xs">
          📌 Pin note
        </button>
      </form>
      {error && <p className="text-[11px] text-red-300">{error}</p>}

      {notes.length > 0 && (
        <div className="space-y-1 text-xs">
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>
              {open.length} open note{open.length === 1 ? '' : 's'}
            </span>
            {notes.length > open.length && (
              <button type="button" onClick={() => setShowResolved((s) => !s)} className="hover:text-zinc-200">
                {showResolved ? 'Hide resolved' : `Show resolved (${notes.length - open.length})`}
              </button>
            )}
          </div>
          <ul className="space-y-1 max-h-64 overflow-y-auto">
            {listed.map((n) => (
              <li key={n.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={n.resolved}
                  onChange={(e) => call('PATCH', { noteId: n.id, resolved: e.target.checked })}
                  title={n.resolved ? 'Open it again' : 'Mark as dealt with'}
                  className="mt-0.5 accent-emerald-500"
                />
                <button type="button" onClick={() => onSeek(n)} className="font-mono text-indigo-300 hover:underline shrink-0">
                  {clock(n.atSec)}
                </button>
                <span className={`flex-1 ${n.resolved ? 'line-through text-zinc-600' : 'text-zinc-300'}`}>
                  {n.source === 'ai' && (
                    <span
                      className={`mr-1.5 inline-block rounded border px-1 py-px text-[10px] font-semibold ${SEVERITY_CLASS[n.severity ?? 'low']}`}
                      title={`Found by the AI watch-through${n.severity ? ` (${n.severity})` : ''}`}
                    >
                      AI{n.kind ? ` · ${KIND_LABEL[n.kind] ?? n.kind}` : ''}
                    </span>
                  )}
                  {n.text}
                </span>
                <button type="button" onClick={() => call('DELETE', undefined, `?noteId=${encodeURIComponent(n.id)}`)} className="text-zinc-600 hover:text-red-300" title="Delete">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
