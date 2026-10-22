'use client';

import React, { useEffect, useState } from 'react';

interface NeedsCheckShot {
  beatIndex: number;
  shotIndex: number;
  covers: string;
}

/**
 * Shots picked while the relevance check was unavailable (usually the Gemini limit), with one
 * button to pick them all again. Stops at the first shot that still can't be checked, since the
 * rest would fail the same way until the limit resets.
 */
export function NeedsCheckBar({ videoId, refreshKey, onChanged }: { videoId: string; refreshKey?: number; onChanged: () => void }) {
  const [shots, setShots] = useState<NeedsCheckShot[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/videos/${videoId}/needs-check`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled && json) setShots(json.shots ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [videoId, refreshKey]);

  async function redoAll() {
    setMessage(null);
    let fixed = 0;
    for (const [i, s] of shots.entries()) {
      setProgress(`Picking shot ${i + 1} of ${shots.length} again (beat #${s.beatIndex + 1})…`);
      try {
        const res = await fetch(`/api/videos/${videoId}/beats/${s.beatIndex}/shots/${s.shotIndex}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'redo' }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const error = String(body.error ?? 'The shot could not be replaced');
          if (/relevance check|paused/i.test(error)) {
            setMessage(`${fixed} fixed. The relevance check is still unavailable; try again once the Gemini limit has reset.`);
            break;
          }
          // Nothing fits this one: leave it and carry on with the rest
          continue;
        }
        fixed++;
        onChanged();
      } catch {
        // Network hiccup on one shot: carry on
      }
    }
    setProgress(null);
    setMessage((m) => m ?? `${fixed} of ${shots.length} shots picked again.`);
    onChanged();
  }

  if (shots.length === 0 && !message) return null;

  return (
    <div className="rounded-2xl border border-amber-700/60 bg-amber-950/20 p-4 text-xs flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-0.5">
        <span className="font-bold text-amber-200">
          {shots.length > 0 ? `${shots.length} shot${shots.length === 1 ? '' : 's'} need${shots.length === 1 ? 's' : ''} a relevance check` : 'Relevance checks'}
        </span>
        <p className="text-amber-100/80">
          {progress ??
            message ??
            "These were made while footage couldn't be checked (usually the Gemini limit), so they show a text card or the neighbouring footage. Pick them again once the limit resets."}
        </p>
      </div>
      {shots.length > 0 && (
        <button
          type="button"
          onClick={redoAll}
          disabled={Boolean(progress)}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold border bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 border-amber-600 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {progress ? 'Working…' : `Pick ${shots.length === 1 ? 'it' : 'them'} again`}
        </button>
      )}
    </div>
  );
}
