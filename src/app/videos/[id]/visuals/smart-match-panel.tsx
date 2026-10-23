'use client';

import React, { useState } from 'react';

interface Proposal {
  fileId: string;
  fileName: string;
  beat_index: number;
  shot_index: number | null;
  startSec: number;
  score: number;
  reason: string;
}

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * Matches the dropped files to shots by what they show (not their names): each file goes to the
 * shot it fits, from its best seconds, and a long clip can fill several shots. Proposals are
 * reviewed here before anything changes.
 */
export function SmartMatchPanel({
  videoId,
  files,
  license,
  attribution,
  onApplied,
}: {
  videoId: string;
  files: File[];
  license: string;
  attribution: string;
  onApplied: () => void;
}) {
  const [step, setStep] = useState<'idle' | 'staging' | 'matching' | 'review' | 'applying' | 'done'>('idle');
  const [progress, setProgress] = useState('');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [keep, setKeep] = useState<Record<number, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [keepInLibrary, setKeepInLibrary] = useState(false);

  async function match() {
    setError(null);
    setSummary(null);
    setStep('staging');
    try {
      const ids: string[] = [];
      for (const [i, file] of files.entries()) {
        setProgress(`Sending ${i + 1} of ${files.length}: ${file.name}`);
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/videos/${videoId}/batch-match/stage`, { method: 'POST', body: form });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Could not send ${file.name}`);
        ids.push(body.id);
        if (keepInLibrary) {
          setProgress(`Adding ${file.name} to your clip library…`);
          const lib = new FormData();
          lib.append('file', file);
          lib.append('license_type', license);
          if (attribution.trim()) lib.append('attribution_text', attribution.trim());
          await fetch('/api/library', { method: 'POST', body: lib }).catch(() => null);
        }
      }
      setStep('matching');
      setProgress('Looking at the footage and matching it to shots… (a minute or two)');
      const res = await fetch(`/api/videos/${videoId}/batch-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: ids }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Matching failed');
      setProposals(body.matches);
      setKeep(Object.fromEntries((body.matches as Proposal[]).map((_, i) => [i, true])));
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('idle');
    }
  }

  async function apply() {
    const chosen = proposals.filter((_, i) => keep[i]);
    if (chosen.length === 0) return;
    setStep('applying');
    setProgress(`Putting ${chosen.length} clip${chosen.length === 1 ? '' : 's'} in… (each shot re-renders)`);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/batch-match/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matches: chosen.map((p) => ({ fileId: p.fileId, beat_index: p.beat_index, shot_index: p.shot_index, startSec: p.startSec })),
          license_type: license,
          attribution_text: attribution,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Applying failed');
      const results = body.results as Array<{ ok: boolean; beat_index: number; error?: string }>;
      const failed = results.filter((r) => !r.ok);
      setSummary(
        `${results.length - failed.length} placed${failed.length ? `; ${failed.length} failed: ${failed.map((f) => `beat ${f.beat_index + 1} (${f.error})`).join(', ')}` : ''}`,
      );
      setStep('done');
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('review');
    }
  }

  const busy = step === 'staging' || step === 'matching' || step === 'applying';
  return (
    <div className="bg-indigo-950/20 border border-indigo-800/50 rounded-xl p-4 space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-white">✨ Match by what&apos;s in them</p>
          <p className="text-zinc-400">
            Each file goes to the shot it fits, from its best seconds; a long clip can fill several shots. Graphics stay. You review
            before anything changes.
          </p>
        </div>
        <button
          type="button"
          onClick={match}
          disabled={busy || files.length === 0}
          className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50 cursor-pointer"
        >
          {step === 'review' || step === 'done' ? 'Match again' : `Match ${files.length} file${files.length === 1 ? '' : 's'}`}
        </button>
      </div>

      <label className="flex items-center gap-2 text-zinc-300 cursor-pointer">
        <input type="checkbox" checked={keepInLibrary} onChange={(e) => setKeepInLibrary(e.target.checked)} disabled={busy} className="accent-indigo-500" />
        Also keep these in my clip library, for future videos
      </label>
      {busy && <p className="text-indigo-200">{progress}</p>}
      {error && <p className="text-red-300">{error}</p>}

      {step === 'review' && (
        <div className="space-y-2">
          {proposals.length === 0 ? (
            <p className="text-zinc-400">No file clearly fits a shot. Try the filename mapping below, or upload into a shot from the shot editor.</p>
          ) : (
            <>
              <ul className="space-y-1">
                {proposals.map((p, i) => (
                  <li key={`${p.fileId}-${p.beat_index}-${p.shot_index}`} className="flex flex-wrap items-center gap-2 p-2 rounded-lg bg-zinc-950/60 border border-zinc-800">
                    <input type="checkbox" checked={Boolean(keep[i])} onChange={(e) => setKeep((k) => ({ ...k, [i]: e.target.checked }))} className="accent-indigo-500" />
                    <span className="text-zinc-200 font-medium truncate max-w-48" title={p.fileName}>
                      {p.fileName}
                    </span>
                    {p.startSec > 0 && <span className="text-zinc-500">from {fmt(p.startSec)}</span>}
                    <span className="text-zinc-500">→</span>
                    <span className="text-zinc-200">
                      Beat {p.beat_index + 1}
                      {p.shot_index !== null ? `, shot ${p.shot_index + 1}` : ''}
                    </span>
                    <span className="text-emerald-300">{p.score}/10</span>
                    <span className="text-zinc-500 italic">{p.reason}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={apply}
                disabled={!Object.values(keep).some(Boolean)}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50 cursor-pointer"
              >
                Put the ticked ones in
              </button>
            </>
          )}
        </div>
      )}
      {step === 'done' && summary && <p className="text-emerald-300">{summary}</p>}
    </div>
  );
}
