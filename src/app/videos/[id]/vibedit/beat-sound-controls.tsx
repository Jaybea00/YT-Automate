'use client';

import React, { useState } from 'react';

interface BeatSound {
  music?: number;
  muteSfx?: boolean;
  pauseAfterSec?: number;
}

const PAUSES = [0, 0.5, 1, 1.5, 2, 3, 4];

/** This beat's sound: the music's level under it, its effects on or off, and a dramatic pause after the line. */
export function BeatSoundControls({ videoId, beatIndex, initial, onSaved }: { videoId: string; beatIndex: number; initial: BeatSound | null; onSaved: () => void }) {
  const [music, setMusic] = useState(initial?.music ?? 1);
  const [muteSfx, setMuteSfx] = useState(Boolean(initial?.muteSfx));
  const [pause, setPause] = useState(initial?.pauseAfterSec ?? 0);
  const [status, setStatus] = useState<string | null>(null);
  const dirty = music !== (initial?.music ?? 1) || muteSfx !== Boolean(initial?.muteSfx) || pause !== (initial?.pauseAfterSec ?? 0);

  async function save(body: BeatSound) {
    setStatus('Saving…');
    const res = await fetch(`/api/videos/${videoId}/beats/${beatIndex}/sound`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return setStatus(json.error || 'Could not save');
    setStatus('Saved: heard on the next render or preview.');
    onSaved();
  }

  const musicLabel = music === 0 ? 'silent' : music < 1 ? `${Math.round(music * 100)}% (quieter)` : music > 1 ? `${Math.round(music * 100)}% (louder)` : 'normal';

  return (
    <div className="space-y-2.5 text-xs">
      <label className="block space-y-1">
        <span className="text-zinc-300">
          Music under this beat: <span className="text-indigo-300">{musicLabel}</span>
        </span>
        <input type="range" min={0} max={2} step={0.05} value={music} onChange={(e) => setMusic(Number(e.target.value))} className="w-full accent-indigo-500" />
      </label>
      <label className="flex items-center gap-1.5 text-zinc-300">
        <input type="checkbox" checked={muteSfx} onChange={(e) => setMuteSfx(e.target.checked)} className="accent-indigo-500" />
        No sound effects during this beat
      </label>
      <label className="flex items-center gap-2 text-zinc-300">
        Dramatic pause after the line:
        <select value={pause} onChange={(e) => setPause(Number(e.target.value))} className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1">
          {PAUSES.map((p) => (
            <option key={p} value={p}>
              {p === 0 ? 'none' : `${p} s`}
            </option>
          ))}
        </select>
      </label>
      {pause > 0 && <p className="text-[11px] text-zinc-500">The picture holds and the music dips while the silence lands.</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => save({ music, muteSfx, pauseAfterSec: pause })}
          disabled={!dirty}
          className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium"
        >
          Save sound
        </button>
        {initial && (
          <button
            type="button"
            onClick={() => {
              setMusic(1);
              setMuteSfx(false);
              setPause(0);
              save({});
            }}
            className="px-2 py-1.5 text-zinc-400 hover:text-zinc-100"
          >
            Reset
          </button>
        )}
        {status && <span className="text-[11px] text-zinc-400">{status}</span>}
      </div>
    </div>
  );
}
