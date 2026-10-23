'use client';

import React, { useCallback, useEffect, useState } from 'react';

interface VersionInfo {
  id: string;
  label: string;
  createdAt: string;
  beats: number;
}

interface Difference {
  beat: number;
  then: string[];
  now: string[];
}

/**
 * Version history: save the edit's pictures and caption edits under a name, see which beats
 * changed since, and roll back (the current state is saved first, so a restore can be undone).
 */
export function VersionsPanel({ videoId, onRestored, onJumpToBeat }: { videoId: string; onRestored: () => void; onJumpToBeat: (index: number) => void }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ id: string; differences: Difference[] } | null>(null);

  const fetchVersions = useCallback(
    () => fetch(`/api/videos/${videoId}/vibedit/versions`).then((r) => r.json()) as Promise<{ versions?: VersionInfo[] }>,
    [videoId],
  );
  useEffect(() => {
    let cancelled = false;
    fetchVersions()
      .then((b) => {
        if (!cancelled) setVersions(b.versions ?? []);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchVersions]);

  async function post(body: Record<string, unknown>, doing: string) {
    setBusy(doing);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/vibedit/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Something went wrong');
      setVersions(json.versions ?? []);
      return json;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function showCompare(id: string) {
    if (compare?.id === id) return setCompare(null);
    setBusy('Comparing…');
    const res = await fetch(`/api/videos/${videoId}/vibedit/versions?compare=${id}`);
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return setError(json.error || 'Could not compare');
    setCompare({ id, differences: json.differences ?? [] });
  }

  async function restore(v: VersionInfo) {
    if (!window.confirm(`Restore "${v.label}"? The pictures of every beat and the caption edits go back to that version. What you have now is saved first, so you can come back to it.`)) return;
    const json = await post({ action: 'restore', versionId: v.id }, 'Restoring…');
    if (json) {
      setCompare(null);
      onRestored();
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-2.5 text-xs">
      <span className="font-bold text-zinc-300 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
        <span>🕘</span> Versions
      </span>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await post({ action: 'save', label }, 'Saving…')) setLabel('');
        }}
        className="flex gap-2"
      >
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name this version, e.g. before the chapter 3 swaps"
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-100"
        />
        <button type="submit" disabled={Boolean(busy)} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40">
          Save version
        </button>
      </form>
      {busy && <p className="text-amber-300">{busy}</p>}
      {error && <p className="text-red-300">{error}</p>}
      {versions?.length === 0 && <p className="text-zinc-500">No versions yet. Save one before a big change; the voice isn&apos;t part of a version.</p>}
      <ul className="space-y-1.5 max-h-72 overflow-y-auto">
        {versions?.map((v) => (
          <li key={v.id} className="p-2 rounded-lg bg-zinc-950 border border-zinc-800 space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-zinc-200 truncate">{v.label}</p>
                <p className="text-[11px] text-zinc-500">{new Date(v.createdAt).toLocaleString()}</p>
              </div>
              <button onClick={() => showCompare(v.id)} disabled={Boolean(busy)} className="text-zinc-400 hover:text-zinc-100">
                {compare?.id === v.id ? 'Hide' : 'Changes since'}
              </button>
              <button onClick={() => restore(v)} disabled={Boolean(busy)} className="text-indigo-300 hover:text-indigo-200">
                Restore
              </button>
              <button
                onClick={() => window.confirm(`Delete "${v.label}"?`) && post({ action: 'delete', versionId: v.id }, 'Deleting…')}
                disabled={Boolean(busy)}
                className="text-zinc-600 hover:text-red-300"
                title="Delete this version"
              >
                ✕
              </button>
            </div>
            {compare?.id === v.id &&
              (compare.differences.length === 0 ? (
                <p className="text-[11px] text-zinc-500">The pictures are the same as in this version.</p>
              ) : (
                <ul className="space-y-1">
                  {compare.differences.map((d) => (
                    <li key={d.beat} className="text-[11px]">
                      <button onClick={() => onJumpToBeat(d.beat)} className="font-semibold text-indigo-300 hover:underline">
                        Beat {d.beat + 1}
                      </button>
                      <div className="grid grid-cols-2 gap-2 mt-0.5">
                        <div className="text-zinc-500">
                          then: {d.then.map((s, i) => <span key={i} className="block truncate" title={s}>{s}</span>)}
                        </div>
                        <div className="text-zinc-300">
                          now: {d.now.map((s, i) => <span key={i} className="block truncate" title={s}>{s}</span>)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
