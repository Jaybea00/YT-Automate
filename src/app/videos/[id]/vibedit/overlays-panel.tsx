'use client';

import React, { useCallback, useEffect, useState } from 'react';

type Kind = 'text' | 'callout' | 'arrow';

interface Overlay {
  id: string;
  kind: Kind;
  beat: number;
  offsetSec: number;
  durationSec: number;
  text: string;
  x: number;
  y: number;
}

const KINDS: Array<{ id: Kind; label: string; hint: string }> = [
  { id: 'text', label: 'Text', hint: 'a line of text, centred where you click' },
  { id: 'callout', label: 'Callout', hint: 'a label with a line to the point you click' },
  { id: 'arrow', label: 'Arrow', hint: 'an arrow pointing at the point you click' },
];

/**
 * Text, callouts and arrows at any moment: pick the kind, write the words, click the frame where
 * it goes, and it's anchored to the beat at the playhead. Shown on the next render or preview.
 */
export function OverlaysPanel({
  videoId,
  activeBeat,
  offsetInBeat,
  onPickPoint,
  onSeek,
}: {
  videoId: string;
  activeBeat: number;
  /** Seconds from the active beat's start to the playhead. */
  offsetInBeat: number;
  /** Asks the page for a click on the frame; resolves with the point (0-1), or null when cancelled. */
  onPickPoint: () => Promise<{ x: number; y: number } | null>;
  onSeek: (beat: number, offsetSec: number) => void;
}) {
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [kind, setKind] = useState<Kind>('callout');
  const [text, setText] = useState('');
  const [duration, setDuration] = useState(3);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOverlays = useCallback(() => fetch(`/api/videos/${videoId}/vibedit/overlays`).then((r) => r.json()) as Promise<{ overlays?: Overlay[] }>, [videoId]);
  useEffect(() => {
    let cancelled = false;
    fetchOverlays()
      .then((b) => {
        if (!cancelled) setOverlays(b.overlays ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchOverlays]);

  async function call(method: string, body?: unknown, query = '') {
    setError(null);
    const res = await fetch(`/api/videos/${videoId}/vibedit/overlays${query}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error || 'Could not save');
      return false;
    }
    setOverlays(json.overlays ?? []);
    return true;
  }

  async function place() {
    if (kind !== 'arrow' && !text.trim()) return setError('Write the words first');
    setPicking(true);
    const point = await onPickPoint();
    setPicking(false);
    if (!point) return;
    const ok = await call('POST', { kind, beat: activeBeat, offsetSec: Math.max(0, offsetInBeat), durationSec: duration, text, ...point });
    if (ok) setText('');
  }

  const here = overlays.filter((o) => o.beat === activeBeat);
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-2.5 text-xs">
      <span className="font-bold text-zinc-300 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
        <span>🏷️</span> Text, callouts & arrows
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => setKind(k.id)}
            title={k.hint}
            className={`px-2.5 py-1 rounded-lg border ${kind === k.id ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-600'}`}
          >
            {k.label}
          </button>
        ))}
        <label className="flex items-center gap-1 text-zinc-400 ml-auto">
          for
          <input type="number" min={1} max={15} step={0.5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-zinc-100" />s
        </label>
      </div>
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={kind === 'arrow' ? 'Label (optional)' : kind === 'text' ? 'e.g. 3 DAYS LATER' : 'e.g. Gatun Locks'}
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-100"
        />
        <button type="button" onClick={place} disabled={picking} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40">
          {picking ? 'Click the frame…' : `＋ Place at beat ${activeBeat + 1}, ${offsetInBeat.toFixed(1)}s`}
        </button>
      </div>
      {picking && <p className="text-amber-300">Click on the video where it goes (Esc to cancel).</p>}
      {error && <p className="text-red-300">{error}</p>}

      {here.length > 0 && (
        <ul className="space-y-1">
          {here.map((o) => (
            <li key={o.id} className="flex items-center gap-2">
              <button type="button" onClick={() => onSeek(o.beat, o.offsetSec)} className="font-mono text-indigo-300 hover:underline shrink-0">
                +{o.offsetSec.toFixed(1)}s
              </button>
              <span className="text-zinc-500 shrink-0">{o.kind}</span>
              <span className="flex-1 truncate text-zinc-200">{o.text || '(arrow)'}</span>
              <input
                type="number"
                min={1}
                max={15}
                step={0.5}
                defaultValue={o.durationSec}
                onBlur={(e) => Number(e.target.value) !== o.durationSec && call('PATCH', { overlayId: o.id, durationSec: Number(e.target.value) })}
                title="Seconds on screen"
                className="w-12 bg-zinc-950 border border-zinc-800 rounded px-1 py-0.5 text-zinc-100"
              />
              <button type="button" onClick={() => call('DELETE', undefined, `?overlayId=${encodeURIComponent(o.id)}`)} className="text-zinc-600 hover:text-red-300" title="Remove">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-zinc-500">
        {overlays.length} in the video{overlays.length > here.length ? ` (${overlays.length - here.length} on other beats)` : ''}. They appear on the next render or preview, under the captions.
      </p>
      {overlays.length > here.length && (
        <div className="flex flex-wrap gap-1">
          {overlays
            .filter((o) => o.beat !== activeBeat)
            .slice(0, 30)
            .map((o) => (
              <button key={o.id} type="button" onClick={() => onSeek(o.beat, o.offsetSec)} className="px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-[10px] text-zinc-400 hover:text-zinc-100" title={o.text}>
                beat {o.beat + 1} · {o.text ? o.text.slice(0, 18) : o.kind}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
