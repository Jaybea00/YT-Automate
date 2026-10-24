'use client';

import React, { useEffect, useRef, useState } from 'react';

interface BeatVoice {
  speed?: number;
  narratorId?: string;
  recorded?: { path: string; durationMs: number };
}

interface Narrator {
  id: string;
  name: string;
  yt_provider_configs?: { label?: string } | null;
}

/**
 * This beat's voice: its pace, another narrator for this line (a quote, a second speaker), or
 * the creator's own recording from the microphone. Saving voices the beat again.
 */
export function BeatVoiceControls({ videoId, beatIndex, initial, onSaved }: { videoId: string; beatIndex: number; initial: BeatVoice | null; onSaved: () => void }) {
  const [speed, setSpeed] = useState(initial?.speed ?? 1);
  const [narratorId, setNarratorId] = useState(initial?.narratorId ?? '');
  const [narrators, setNarrators] = useState<Narrator[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [take, setTake] = useState<{ blob: Blob; url: string } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/narrators')
      .then((r) => r.json())
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setNarrators(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (take) URL.revokeObjectURL(take.url);
  }, [take]);

  const dirty = speed !== (initial?.speed ?? 1) || narratorId !== (initial?.narratorId ?? '');

  async function send(init: RequestInit, url: string, doing: string) {
    setBusy(doing);
    setStatus(null);
    try {
      const res = await fetch(url, init);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Voicing failed');
      setStatus('Voiced: heard on the next render or preview.');
      setTake(null);
      onSaved();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const saveSettings = (body: Record<string, unknown>) =>
    send({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, `/api/videos/${videoId}/beats/${beatIndex}/voice`, 'Voicing this beat… (a local voice can take a minute)');

  async function startRecording() {
    setStatus(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        setTake({ blob, url: URL.createObjectURL(blob) });
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch {
      setStatus('The microphone is not available (allow it in the browser).');
    }
  }

  function stopRecording() {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  }

  function applyTake() {
    if (!take) return;
    const form = new FormData();
    form.append('audio', take.blob, take.blob.type.includes('ogg') ? 'take.ogg' : 'take.webm');
    send({ method: 'POST', body: form }, `/api/videos/${videoId}/beats/${beatIndex}/record`, 'Cleaning up and using your recording…');
  }

  return (
    <div className="space-y-2.5 text-xs">
      {initial?.recorded ? (
        <div className="flex items-center gap-2 p-2 rounded-lg bg-emerald-950/40 border border-emerald-900 text-emerald-200">
          🎙️ This beat uses your recording ({(initial.recorded.durationMs / 1000).toFixed(1)} s).
          <button type="button" disabled={Boolean(busy)} onClick={() => saveSettings({ removeRecording: true })} className="ml-auto text-zinc-300 hover:text-white">
            Remove (use the narrator)
          </button>
        </div>
      ) : (
        <>
          <label className="block space-y-1">
            <span className="text-zinc-300">
              Pace: <span className="text-indigo-300">{speed === 1 ? 'normal' : `${Math.round(speed * 100)}% (${speed < 1 ? 'slower' : 'faster'})`}</span>
            </span>
            <input type="range" min={0.75} max={1.25} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full accent-indigo-500" />
          </label>
          <label className="block space-y-1 text-zinc-300">
            <span>Narrator for this line:</span>
            <select value={narratorId} onChange={(e) => setNarratorId(e.target.value)} className="block w-full max-w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1">
              <option value="">The video&apos;s narrator</option>
              {narrators.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                  {n.yt_provider_configs?.label ? ` (${n.yt_provider_configs.label})` : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => saveSettings({ speed, narratorId: narratorId || null })}
            disabled={!dirty || Boolean(busy)}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium"
          >
            Save and re-voice
          </button>
        </>
      )}

      <div className="pt-2 border-t border-zinc-800 space-y-2">
        <div className="flex items-center gap-2">
          {recording ? (
            <button type="button" onClick={stopRecording} className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium animate-pulse">
              ■ Stop
            </button>
          ) : (
            <button type="button" onClick={startRecording} disabled={Boolean(busy)} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40">
              🎙️ {initial?.recorded ? 'Record again' : 'Record this line yourself'}
            </button>
          )}
          {recording && <span className="text-red-300">Recording… read the line, then stop.</span>}
        </div>
        {take && !recording && (
          <div className="flex items-center gap-2">
            <audio src={take.url} controls className="h-8 flex-1" />
            <button type="button" onClick={applyTake} disabled={Boolean(busy)} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-40">
              Use this take
            </button>
            <button type="button" onClick={() => setTake(null)} className="text-zinc-400 hover:text-zinc-100">
              Discard
            </button>
          </div>
        )}
      </div>
      {busy && <p className="text-amber-300">{busy}</p>}
      {status && !busy && <p className="text-[11px] text-zinc-400">{status}</p>}
    </div>
  );
}
