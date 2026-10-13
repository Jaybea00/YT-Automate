'use client';

import React, { useEffect, useState } from 'react';

export interface VoiceIssue {
  type: 'skipped' | 'added' | 'mispronounced' | 'garbled' | 'cut_off';
  expected?: string | null;
  heard?: string | null;
}

export interface BeatVoiceCheck {
  beatIndex: number;
  result?: { ok: boolean; transcript: string; issues: VoiceIssue[]; checkedAt: string };
  error?: string;
}

const ISSUE_LABEL: Record<VoiceIssue['type'], string> = {
  skipped: 'Skipped',
  added: 'Added',
  mispronounced: 'Mispronounced',
  garbled: 'Garbled',
  cut_off: 'Cut off',
};

const button =
  'px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

export function describeIssue(issue: VoiceIssue): string {
  const parts = [ISSUE_LABEL[issue.type]];
  if (issue.expected) parts.push(`"${issue.expected}"`);
  if (issue.heard) parts.push(`heard "${issue.heard}"`);
  return parts.join(' ');
}

/** Small per-beat badge shown next to the beat's audio player. */
export function VoiceCheckBadge({ check }: { check?: BeatVoiceCheck }) {
  if (!check?.result) return null;
  return check.result.ok ? (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
      🎧 Matches script
    </span>
  ) : (
    <span
      className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300"
      title={check.result.issues.map(describeIssue).join('\n')}
    >
      🎧 {check.result.issues.length} issue{check.result.issues.length === 1 ? '' : 's'}
    </span>
  );
}

/**
 * Listen-back check: transcribes each voiced beat and compares it with the text the voice was
 * given, flagging skipped, added, mispronounced or garbled words, with one-click re-voicing.
 */
export function VoiceCheckPanel({
  videoId,
  onChecks,
  onRevoiced,
}: {
  videoId: string;
  onChecks: (checks: Map<number, BeatVoiceCheck>) => void;
  onRevoiced: () => void;
}) {
  const [checks, setChecks] = useState<Map<number, BeatVoiceCheck>>(new Map());
  const [voicedBeats, setVoicedBeats] = useState(0);
  const [isChecking, setIsChecking] = useState(false);
  const [revoicing, setRevoicing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function merge(list: BeatVoiceCheck[], voiced?: number) {
    setChecks((prev) => {
      const next = new Map(prev);
      for (const c of list) next.set(c.beatIndex, c);
      return next;
    });
    if (voiced !== undefined) setVoicedBeats(voiced);
  }

  // Share results with the page (for per-beat badges) after they're committed
  useEffect(() => {
    onChecks(checks);
  }, [checks, onChecks]);

  useEffect(() => {
    fetch(`/api/videos/${videoId}/voice/check`)
      .then((r) => r.json())
      .then((json) => merge(json.checks ?? [], json.voicedBeats ?? 0))
      .catch(() => {});
  }, [videoId]);

  async function runCheck(beatIndexes?: number[], force = false) {
    const res = await fetch(`/api/videos/${videoId}/voice/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beatIndexes, force }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Voice check failed');
    merge(json.checks ?? [], json.voicedBeats);
  }

  async function checkAll() {
    setIsChecking(true);
    setError(null);
    try {
      await runCheck();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Voice check failed');
    } finally {
      setIsChecking(false);
    }
  }

  async function revoice(beatIndex: number) {
    setRevoicing(beatIndex);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/beats/${beatIndex}/regen-tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Re-voicing failed');
      onRevoiced();
      await runCheck([beatIndex], true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-voicing failed');
    } finally {
      setRevoicing(null);
    }
  }

  const results = [...checks.values()].filter((c) => c.result);
  const flagged = results.filter((c) => !c.result!.ok).sort((a, b) => a.beatIndex - b.beatIndex);
  const failed = [...checks.values()].filter((c) => c.error);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-sm font-bold text-white">🎧 Voice check</span>
          <p className="text-zinc-400 mt-0.5">
            Listens back to every voiced beat and flags skipped, added, mispronounced or garbled words.
          </p>
        </div>
        <button
          type="button"
          onClick={checkAll}
          disabled={isChecking || voicedBeats === 0}
          className={`${button} bg-sky-950/60 hover:bg-sky-900/70 text-sky-200 border-sky-800`}
        >
          {isChecking ? 'Listening…' : results.length ? 'Check again' : 'Check voiced beats'}
        </button>
      </div>

      {voicedBeats === 0 && <p className="text-zinc-500">No voiced beats yet.</p>}
      {results.length > 0 && (
        <p className={flagged.length ? 'text-amber-300' : 'text-emerald-300'}>
          {results.length} of {voicedBeats} beats checked · {flagged.length ? `${flagged.length} need attention` : 'all match the script'}
        </p>
      )}
      {isChecking && <p className="text-zinc-500">Checking up to 3 beats at a time; this can take a few minutes.</p>}
      {error && <p className="text-red-300">{error}</p>}
      {failed.length > 0 && (
        <p className="text-zinc-500">
          Couldn&apos;t check beat{failed.length === 1 ? '' : 's'} {failed.map((c) => `#${c.beatIndex + 1}`).join(', ')}: {failed[0].error}
        </p>
      )}

      {flagged.length > 0 && (
        <ul className="space-y-2">
          {flagged.map((c) => (
            <li key={c.beatIndex} className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-3 flex items-start justify-between gap-3">
              <div className="space-y-1">
                <span className="font-semibold text-amber-200">Beat #{c.beatIndex + 1}</span>
                <ul className="text-amber-100/90 list-disc pl-4">
                  {c.result!.issues.map((issue, i) => (
                    <li key={i}>{describeIssue(issue)}</li>
                  ))}
                </ul>
                <p className="text-zinc-500">Heard: {c.result!.transcript}</p>
              </div>
              <button
                type="button"
                onClick={() => revoice(c.beatIndex)}
                disabled={revoicing !== null}
                className={`${button} shrink-0 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border-zinc-700`}
              >
                {revoicing === c.beatIndex ? 'Re-voicing…' : 'Re-voice'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
