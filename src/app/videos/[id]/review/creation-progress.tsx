'use client';

import React, { useEffect, useState } from 'react';
import { CREATION_STEP_LABELS, type CreationStep } from '@/lib/script/creation-steps';

/**
 * A new video's background writing on the review page: the step under way, its place in the
 * queue, and a Retry when the writing failed or was lost (the server restarted mid-way).
 */

interface CreationInfo {
  request?: { mode?: 'ai' | 'raw_ai'; topic?: string; brief?: string | null };
  step?: CreationStep;
  attempts?: number;
  error?: string | null;
}

interface QueueStatus {
  active: boolean;
  queued: boolean;
  ahead: number;
}

export function creationOf(scriptJson: unknown): CreationInfo | null {
  const c = (scriptJson as { creation?: CreationInfo } | null | undefined)?.creation;
  return c && typeof c === 'object' && c.request ? c : null;
}

function stepsFor(creation: CreationInfo): CreationStep[] {
  if (creation.request?.mode === 'raw_ai') return ['segmenting', 'shots'];
  return creation.request?.brief ? ['research', 'packaging', 'outline'] : ['research', 'packaging', 'writing', 'shots', 'checks'];
}

export function RetryCreationButton({ videoId, onRetried, label = 'Try again' }: { videoId: string; onRetried: () => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/creation`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not start again.');
      onRetried();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={retry}
        disabled={busy}
        className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition disabled:opacity-50"
      >
        {busy ? 'Starting…' : label}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}

export function CreationProgress({ videoId, scriptJson, onRetried }: { videoId: string; scriptJson: unknown; onRetried: () => void }) {
  const creation = creationOf(scriptJson);
  const [queue, setQueue] = useState<QueueStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () =>
      fetch(`/api/videos/${videoId}/creation`)
        .then((res) => (res.ok ? res.json() : null))
        .then((q: QueueStatus | null) => !cancelled && q && setQueue(q))
        .catch(() => {});
    void check();
    const interval = setInterval(check, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [videoId]);

  const lost = queue !== null && !queue.active && !queue.queued;
  const steps = creation ? stepsFor(creation) : [];
  const current = creation?.step ?? 'waiting';
  const currentIndex = steps.indexOf(current);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 sm:p-10 space-y-6 shadow-xl">
      <div className="flex items-center gap-4">
        {!lost && <div className="w-10 h-10 shrink-0 rounded-full border-4 border-blue-500/20 border-t-blue-500 animate-spin" />}
        <div>
          <h2 className="text-xl font-bold text-white">
            {lost ? 'Writing stopped' : current === 'waiting' ? 'Waiting to start writing…' : 'Writing your script…'}
          </h2>
          <p className="text-sm text-zinc-400 mt-1">
            {lost
              ? 'The writing was interrupted (the app was probably restarted). Start it again from the same topic and settings.'
              : queue?.queued
                ? `Queued behind ${queue.ahead} other video${queue.ahead === 1 ? '' : 's'}. You can leave this page; it carries on in the background.`
                : 'Runs in the background: you can leave this page and come back. It updates here by itself.'}
          </p>
        </div>
      </div>

      {creation && steps.length > 0 && (
        <ol className="space-y-2">
          {steps.map((s, i) => {
            const done = currentIndex > i;
            const active = currentIndex === i && !lost;
            return (
              <li key={s} className="flex items-center gap-3 text-sm">
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] border ${
                    done
                      ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                      : active
                        ? 'bg-blue-500/20 border-blue-500/40 text-blue-300'
                        : 'border-zinc-700 text-zinc-600'
                  }`}
                >
                  {done ? '✓' : i + 1}
                </span>
                <span className={done ? 'text-zinc-400' : active ? 'text-white font-medium' : 'text-zinc-500'}>{CREATION_STEP_LABELS[s]}</span>
                {active && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />}
              </li>
            );
          })}
        </ol>
      )}

      {lost && creation && <RetryCreationButton videoId={videoId} onRetried={onRetried} label="Start again" />}
      {lost && !creation && (
        <a href="/videos/new" className="inline-block px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm">
          Create it again
        </a>
      )}
    </div>
  );
}
