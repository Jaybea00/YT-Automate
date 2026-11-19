'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { MOOD_INFO, isDeliveryMood } from '@/lib/script/delivery-moods';

interface PlanSummary {
  moods: Record<string, number>;
  speakers: string[];
  lines: number;
  beats: number;
}

const button = 'px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * The voice plan made when the script was approved: a mood for each beat and voices for quoted
 * characters. Plan either again here; the beats whose plan changed can then be re-voiced.
 * Each beat can also be changed by hand in Vibedit.
 */
export function VoicePlanPanel({ videoId, onRevoiced }: { videoId: string; onRevoiced: () => void }) {
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [changed, setChanged] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchPlan = useCallback(() => fetch(`/api/videos/${videoId}/voice/plan`, { cache: 'no-store' }).then((r) => (r.ok ? (r.json() as Promise<PlanSummary>) : null)), [videoId]);

  useEffect(() => {
    let cancelled = false;
    fetchPlan()
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchPlan]);

  async function replan(what: { moods: boolean; characters: boolean }, label: string) {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/voice/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(what) });
      const json = (await res.json()) as { summary?: string; changed?: number[]; warnings?: string[]; error?: string };
      if (!res.ok) throw new Error(json.error || 'Planning failed');
      setChanged(json.changed ?? []);
      setMessage(`${json.summary}.${json.warnings?.length ? ` ${json.warnings.join(' ')}` : ''}`);
      setPlan(await fetchPlan());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function revoiceChanged() {
    setError(null);
    const todo = [...changed];
    for (const [i, beatIndex] of todo.entries()) {
      setBusy(`Re-voicing beat ${beatIndex + 1} (${i + 1} of ${todo.length})…`);
      try {
        const res = await fetch(`/api/videos/${videoId}/beats/${beatIndex}/regen-tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Beat ${beatIndex + 1} failed`);
        setChanged((c) => c.filter((x) => x !== beatIndex));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        break;
      }
    }
    setBusy(null);
    onRevoiced();
  }

  const moodEntries = Object.entries(plan?.moods ?? {}).filter(([m]) => isDeliveryMood(m));
  const neutral = plan ? plan.beats - moodEntries.reduce((s, [, n]) => s + n, 0) : 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-sm font-bold text-white">🎭 Voice plan</span>
          <p className="text-zinc-400 mt-0.5">How each line is delivered, and voices for quoted characters. Change single beats in Vibedit.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={Boolean(busy)} onClick={() => replan({ moods: true, characters: false }, 'Suggesting moods…')} className={`${button} bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border-zinc-700`}>
            Suggest moods again
          </button>
          <button type="button" disabled={Boolean(busy)} onClick={() => replan({ moods: false, characters: true }, 'Finding characters…')} className={`${button} bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border-zinc-700`}>
            Find characters again
          </button>
        </div>
      </div>

      {plan && (
        <div className="flex flex-wrap gap-1.5">
          {moodEntries.length === 0 && <span className="text-zinc-500">No moods set: every line is read the same way.</span>}
          {moodEntries.map(([m, n]) => (
            <span key={m} className="px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-200" title={MOOD_INFO[m as keyof typeof MOOD_INFO].use}>
              {MOOD_INFO[m as keyof typeof MOOD_INFO].emoji} {MOOD_INFO[m as keyof typeof MOOD_INFO].label} {n}
            </span>
          ))}
          {moodEntries.length > 0 && <span className="px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400">⚪ Neutral {neutral}</span>}
          <span className="px-2 py-0.5 rounded-full bg-violet-950/40 border border-violet-900 text-violet-200">
            🗣️ {plan.speakers.length ? `${plan.speakers.join(', ')} (${plan.lines} line${plan.lines === 1 ? '' : 's'})` : 'No character voices'}
          </span>
        </div>
      )}

      {message && <p className="text-zinc-300">{message}</p>}
      {changed.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-amber-300">{changed.length} beat{changed.length === 1 ? '' : 's'} changed and will sound different once re-voiced.</span>
          <button type="button" disabled={Boolean(busy)} onClick={revoiceChanged} className={`${button} bg-amber-600 hover:bg-amber-500 text-white border-amber-500`}>
            Re-voice them now
          </button>
        </div>
      )}
      {busy && <p className="text-amber-300">{busy}</p>}
      {error && <p className="text-red-300">{error}</p>}
    </div>
  );
}
