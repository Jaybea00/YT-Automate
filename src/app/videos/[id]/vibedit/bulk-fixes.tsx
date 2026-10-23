'use client';

import React, { useCallback, useEffect, useState } from 'react';

interface Status {
  kind: 'flagged' | 'text_cards';
  state: 'planning' | 'running' | 'done' | 'failed';
  total: number;
  done: number;
  failed: number;
  snapshotId?: string;
  error?: string;
}

const LABELS = {
  flagged: { button: '↻ Redo every flagged shot', confirm: 'Pick every flagged shot again (fallbacks and unchecked footage)?' },
  text_cards: { button: '🎞️ Every text card to footage', confirm: 'Replace every text card with real footage of what it says?' },
} as const;

/**
 * Bulk fixes: every flagged shot picked again, or every text card turned into footage. They run
 * in the background with progress here; one Undo puts the whole run back.
 */
export function BulkFixes({ videoId, onApplied }: { videoId: string; onApplied: () => void }) {
  const [counts, setCounts] = useState<{ flagged: number; text_cards: number } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);

  const fetchState = useCallback(
    () => fetch(`/api/videos/${videoId}/vibedit/bulk`).then((r) => r.json()) as Promise<{ counts?: { flagged: number; text_cards: number }; status?: Status | null }>,
    [videoId],
  );

  useEffect(() => {
    let cancelled = false;
    fetchState()
      .then((b) => {
        if (cancelled) return;
        setCounts(b.counts ?? null);
        setStatus(b.status ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchState]);

  const active = status?.state === 'planning' || status?.state === 'running';
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      const b = await fetchState().catch(() => null);
      if (!b) return;
      setStatus(b.status ?? null);
      setCounts(b.counts ?? null);
      if (b.status && b.status.state !== 'planning' && b.status.state !== 'running') onApplied();
    }, 4000);
    return () => clearInterval(timer);
  }, [active, fetchState, onApplied]);

  async function start(kind: Status['kind']) {
    if (!window.confirm(`${LABELS[kind].confirm}\n\nEach shot can take up to a minute; it runs in the background and can be undone.`)) return;
    setError(null);
    setUndone(false);
    const res = await fetch(`/api/videos/${videoId}/vibedit/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error || 'Could not start');
    setStatus(body.status);
  }

  async function undo(snapshotId: string) {
    const res = await fetch(`/api/videos/${videoId}/vibedit/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error || 'Could not undo');
    setUndone(true);
    setCounts((await fetchState()).counts ?? null);
    onApplied();
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-2.5 text-xs">
      <span className="font-bold text-zinc-300 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
        <span>🧹</span> Bulk fixes
      </span>
      <div className="flex flex-wrap gap-2">
        {(['flagged', 'text_cards'] as const).map((kind) => (
          <button
            key={kind}
            onClick={() => start(kind)}
            disabled={active || !counts?.[kind]}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40 text-zinc-100"
          >
            {LABELS[kind].button} ({counts?.[kind] ?? '…'})
          </button>
        ))}
      </div>
      {status?.state === 'planning' && <p className="text-amber-300">Working out the changes…</p>}
      {status?.state === 'running' && (
        <div className="space-y-1">
          <p className="text-amber-300">
            {status.done + status.failed} of {status.total} shots done{status.failed ? ` (${status.failed} couldn't be changed)` : ''}…
          </p>
          <div className="h-1.5 rounded bg-zinc-800 overflow-hidden">
            <div className="h-full bg-indigo-500" style={{ width: `${status.total ? ((status.done + status.failed) / status.total) * 100 : 0}%` }} />
          </div>
        </div>
      )}
      {status?.state === 'done' && !undone && (
        <p className="text-emerald-300 flex items-center gap-3">
          <span>
            Last run: {status.done} of {status.total} changed{status.failed ? `, ${status.failed} left as they were` : ''}. Re-assemble to see it.
          </span>
          {status.snapshotId && (
            <button onClick={() => undo(status.snapshotId!)} className="text-zinc-400 hover:text-zinc-100">
              ↶ Undo
            </button>
          )}
        </p>
      )}
      {undone && <p className="text-zinc-400">Undone: the shots are back as they were.</p>}
      {status?.state === 'failed' && <p className="text-red-300">The bulk fix stopped: {status.error}</p>}
      {error && <p className="text-red-300">{error}</p>}
    </div>
  );
}
