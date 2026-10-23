'use client';

import React, { useCallback, useEffect, useState } from 'react';

interface Note {
  id: string;
  atSec: number;
  beat: number;
  text: string;
  resolved: boolean;
}

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
              📌
            </button>
          ))}
        </div>
      )}

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
          <ul className="space-y-1 max-h-40 overflow-y-auto">
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
                <span className={`flex-1 ${n.resolved ? 'line-through text-zinc-600' : 'text-zinc-300'}`}>{n.text}</span>
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
