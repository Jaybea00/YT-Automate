'use client';

import React, { useEffect, useState } from 'react';

interface Pronunciation {
  term: string;
  say: string;
}

const button =
  'px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Channel-wide pronunciation list: how the narrator should say names and terms it gets wrong.
 * Applied to every video's narration before voicing (captions keep the written form).
 */
export function PronunciationEditor() {
  const [rows, setRows] = useState<Pronunciation[]>([]);
  const [previewText, setPreviewText] = useState('On Oct. 29, 1929, the Creditanstalt and Wall St. both shook.');
  const [preview, setPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings/pronunciations')
      .then((r) => r.json())
      .then((json) => setRows(json.pronunciations ?? []))
      .catch(() => setStatus('Could not load the pronunciation list.'));
  }, []);

  async function save() {
    setIsSaving(true);
    setStatus(null);
    try {
      const res = await fetch('/api/settings/pronunciations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pronunciations: rows, preview: previewText }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Save failed');
      setRows(json.pronunciations);
      setPreview(json.preview ?? null);
      setStatus('Saved. Beats using these words are re-voiced the next time voicing runs.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsSaving(false);
    }
  }

  const update = (i: number, field: keyof Pronunciation, value: string) =>
    setRows((prev) => prev.map((r, k) => (k === i ? { ...r, [field]: value } : r)));

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4">
      <div>
        <h2 className="text-lg font-bold text-white">🗣️ Pronunciations</h2>
        <p className="text-xs text-zinc-400 mt-1">
          Tell the narrator how to say names and terms it gets wrong. Applied to every video before voicing; captions
          keep the written spelling. Common abbreviations (Oct., St., Dr., vs.) are already handled.
        </p>
      </div>

      <div className="space-y-2">
        {rows.length === 0 && <p className="text-xs text-zinc-500 italic">No custom pronunciations yet.</p>}
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap gap-2 items-center">
            <input
              value={row.term}
              onChange={(e) => update(i, 'term', e.target.value)}
              placeholder="Written as, e.g. Creditanstalt"
              className="flex-1 min-w-[10rem] px-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-red-500"
            />
            <span className="text-zinc-500 text-xs">say</span>
            <input
              value={row.say}
              onChange={(e) => update(i, 'say', e.target.value)}
              placeholder="e.g. kreh-dit-AHN-shtalt"
              className="flex-1 min-w-[10rem] px-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-red-500"
            />
            <button
              type="button"
              onClick={() => setRows((prev) => prev.filter((_, k) => k !== i))}
              className="p-1.5 rounded hover:bg-red-950/50 text-zinc-500 hover:text-red-400 text-xs cursor-pointer"
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <label className="text-xs text-zinc-400 block">Preview sentence (shows exactly what the narrator will be given)</label>
        <input
          value={previewText}
          onChange={(e) => setPreviewText(e.target.value)}
          className="w-full px-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-red-500"
        />
        {preview && <p className="text-xs text-emerald-300 font-mono bg-zinc-950/60 p-2 rounded-lg">{preview}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setRows((prev) => [...prev, { term: '', say: '' }])}
          className={`${button} bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-zinc-700`}
        >
          + Add word
        </button>
        <button
          type="button"
          onClick={save}
          disabled={isSaving}
          className={`${button} bg-red-600 hover:bg-red-500 text-white border-red-500`}
        >
          {isSaving ? 'Saving…' : 'Save & preview'}
        </button>
        {status && <span className="text-xs text-zinc-400">{status}</span>}
      </div>
    </section>
  );
}
