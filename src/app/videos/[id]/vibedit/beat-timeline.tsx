'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface View {
  beat: number;
  fps: number;
  totalSec: number;
  voiceStartSec: number;
  shots: Array<{ index: number; type: string; kind: string; label: string; startSec: number; durationSec: number; frames: number }>;
  peaks: number[];
  peaksPerSec: number;
  words: Array<{ word: string; start: number; end: number }>;
}

type Drag =
  | { kind: 'cut'; cut: number; fromSec: number; atSec: number }
  | { kind: 'shot'; index: number; startX: number; atSec: number };

const W = 1000;
const WAVE_H = 70;
const WORDS_H = 18;
const SHOTS_Y = WAVE_H + WORDS_H + 6;
const SHOTS_H = 46;
const H = SHOTS_Y + SHOTS_H + 2;
const COLORS: Record<string, string> = { footage: '#2563eb', graphic: '#7c3aed', text: '#d97706', blank: '#52525b' };
/** Cuts snap to a word's start or end within this many seconds. */
const SNAP_SEC = 0.15;

/**
 * The active beat's timeline: its shots over the narration's waveform and words. Drag a shot
 * to put it elsewhere in the beat; drag a cut (the handle between two shots) to move it, snapping
 * to the words. Changes apply straight away; the next render or preview shows them.
 */
export function BeatTimeline({ videoId, beatIndex, onChanged }: { videoId: string; beatIndex: number; onChanged: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  const fetchView = useCallback(async () => {
    const res = await fetch(`/api/videos/${videoId}/beats/${beatIndex}/timeline`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Could not load the timeline');
    return json as View;
  }, [videoId, beatIndex]);

  useEffect(() => {
    let cancelled = false;
    fetchView()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [fetchView]);

  if (error && !view) return <p className="text-[11px] text-zinc-500">{error}</p>;
  if (!view) return <p className="text-[11px] text-zinc-500">Loading the timeline…</p>;

  const x = (sec: number) => (sec / Math.max(0.01, view.totalSec)) * W;
  const secAt = (clientX: number) => {
    const rect = svg.current!.getBoundingClientRect();
    return Math.max(0, Math.min(view.totalSec, ((clientX - rect.left) / rect.width) * view.totalSec));
  };
  const snap = (sec: number) => {
    let best = sec;
    let dist = SNAP_SEC;
    for (const w of view.words) {
      for (const edge of [w.start, w.end]) {
        if (Math.abs(edge - sec) < dist) {
          dist = Math.abs(edge - sec);
          best = edge;
        }
      }
    }
    return best;
  };

  async function change(body: Record<string, unknown>, doing: string) {
    setBusy(doing);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/beats/${beatIndex}/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not change the beat');
      setView(json);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function onMove(e: React.PointerEvent) {
    if (!drag) return;
    const t = secAt(e.clientX);
    setDrag({ ...drag, atSec: drag.kind === 'cut' ? snap(t) : t });
  }

  function onUp() {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === 'cut') {
      const deltaFrames = Math.round((d.atSec - d.fromSec) * view!.fps);
      if (deltaFrames !== 0) change({ action: 'move_cut', cut: d.cut, deltaFrames }, 'Moving the cut… (the two shots are re-cut)');
      return;
    }
    // Dropped shot: its new place is the slot under the pointer
    const target = view!.shots.findIndex((s) => d.atSec >= s.startSec && d.atSec < s.startSec + s.durationSec);
    if (target < 0 || target === d.index) return;
    const order = view!.shots.map((s) => s.index).filter((i) => i !== d.index);
    order.splice(target, 0, d.index);
    change({ action: 'reorder', order }, 'Reordering the shots…');
  }

  // Waveform as a mirrored filled path
  const peaksX = (i: number) => x(view.voiceStartSec + i / view.peaksPerSec);
  const mid = WAVE_H / 2;
  const top = view.peaks.map((p, i) => `${peaksX(i).toFixed(1)},${(mid - p * mid * 0.95).toFixed(1)}`);
  const bottom = view.peaks.map((p, i) => `${peaksX(i).toFixed(1)},${(mid + p * mid * 0.95).toFixed(1)}`).reverse();
  // Word labels where there is room for them
  const labelled = view.words.reduce<{ shown: boolean[]; last: number }>(
    (acc, w) => {
      const show = x(w.start) - acc.last > 46;
      return { shown: [...acc.shown, show], last: show ? x(w.start) : acc.last };
    },
    { shown: [], last: -Infinity },
  ).shown;

  return (
    <div className="space-y-1.5 text-xs">
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className={`w-full select-none touch-none ${busy ? 'opacity-50 pointer-events-none' : ''}`}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => setDrag(null)}
      >
        <rect x={0} y={0} width={W} height={WAVE_H} fill="#09090b" rx={4} />
        {view.peaks.length > 0 && <polygon points={[...top, ...bottom].join(' ')} fill="#4f46e5" opacity={0.7} />}
        {view.words.map((w, i) => {
          const wx = x(w.start);
          const show = labelled[i];
          return (
            <g key={i}>
              <line x1={wx} x2={wx} y1={WAVE_H} y2={WAVE_H + 4} stroke="#52525b" />
              {show && (
                <text x={wx + 1} y={WAVE_H + 14} fontSize={10} fill="#a1a1aa">
                  {w.word.slice(0, 10)}
                </text>
              )}
            </g>
          );
        })}
        {view.shots.map((s) => {
          const dragging = drag?.kind === 'shot' && drag.index === s.index;
          return (
            <g
              key={s.index}
              onPointerDown={(e) => {
                (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                setDrag({ kind: 'shot', index: s.index, startX: e.clientX, atSec: s.startSec + s.durationSec / 2 });
              }}
              style={{ cursor: 'grab' }}
              opacity={dragging ? 0.5 : 1}
            >
              <rect x={x(s.startSec) + 1} y={SHOTS_Y} width={Math.max(2, x(s.durationSec) - 2)} height={SHOTS_H} rx={4} fill={COLORS[s.kind] ?? '#3f3f46'} stroke="#09090b" strokeWidth={2} />
              <clipPath id={`clip-${beatIndex}-${s.index}`}>
                <rect x={x(s.startSec) + 4} y={SHOTS_Y} width={Math.max(0, x(s.durationSec) - 8)} height={SHOTS_H} />
              </clipPath>
              <text x={x(s.startSec) + 6} y={SHOTS_Y + 18} fontSize={11} fill="#fafafa" clipPath={`url(#clip-${beatIndex}-${s.index})`}>
                {s.index + 1}. {s.type}
              </text>
              <text x={x(s.startSec) + 6} y={SHOTS_Y + 34} fontSize={10} fill="#e4e4e7" opacity={0.8} clipPath={`url(#clip-${beatIndex}-${s.index})`}>
                {s.label}
              </text>
            </g>
          );
        })}
        {drag?.kind === 'shot' && <line x1={x(drag.atSec)} x2={x(drag.atSec)} y1={SHOTS_Y - 4} y2={H} stroke="#fafafa" strokeWidth={2} />}
        {view.shots.slice(0, -1).map((s, cut) => {
          const at = s.startSec + s.durationSec;
          const shown = drag?.kind === 'cut' && drag.cut === cut ? drag.atSec : at;
          return (
            <g
              key={`cut-${cut}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                setDrag({ kind: 'cut', cut, fromSec: at, atSec: at });
              }}
              style={{ cursor: 'ew-resize' }}
            >
              <line x1={x(shown)} x2={x(shown)} y1={0} y2={H} stroke={drag?.kind === 'cut' && drag.cut === cut ? '#fbbf24' : '#fafafa'} strokeWidth={2} opacity={0.85} />
              <rect x={x(shown) - 7} y={SHOTS_Y + 10} width={14} height={SHOTS_H - 20} rx={3} fill="#fafafa" />
            </g>
          );
        })}
      </svg>
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>
          {drag?.kind === 'cut'
            ? `Cut ${drag.cut + 1} → ${drag.atSec.toFixed(2)} s (${drag.atSec >= drag.fromSec ? '+' : ''}${(drag.atSec - drag.fromSec).toFixed(2)} s)`
            : 'Drag a shot to move it; drag a white handle to move a cut (it snaps to the words).'}
        </span>
        <span className="font-mono">{view.totalSec.toFixed(1)} s</span>
      </div>
      {busy && <p className="text-amber-300">{busy}</p>}
      {error && <p className="text-red-300">{error}</p>}
    </div>
  );
}
