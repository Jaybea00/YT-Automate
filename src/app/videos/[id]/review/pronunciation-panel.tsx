'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import type { ScriptBeat } from '@/lib/script/generate-script';
import type { PronunciationHint, PronunciationHints } from '@/lib/script/pronunciation-hints-types';

const smallButton =
  'px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 cursor-pointer disabled:opacity-50 disabled:cursor-default';

/**
 * Names the voice may mispronounce, with suggested respellings. Ticked ones are added to the
 * channel's pronunciation list when the script is approved (or now, with "Add now"). The page
 * remounts it (key = checkedAt) when a new check replaces the hints.
 */
export function PronunciationPanel({
  videoId,
  hints,
  beats,
  onHints,
}: {
  videoId: string;
  hints: PronunciationHints | undefined;
  beats: ScriptBeat[];
  onHints: (hints: PronunciationHints) => void;
}) {
  const [rows, setRows] = useState<PronunciationHint[]>(hints?.hints ?? []);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | 'finding' | 'saving' | 'adding'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const change = (i: number, patch: Partial<PronunciationHint>) => {
    setRows((r) => r.map((h, j) => (j === i ? { ...h, ...patch } : h)));
    setDirty(true);
  };

  async function request(kind: 'finding' | 'saving' | 'adding', method: string, body: unknown) {
    setBusy(kind);
    setMessage(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/script/pronunciations`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setRows(data.pronunciation_hints.hints);
      setDirty(false);
      onHints(data.pronunciation_hints);
      return data;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const pending = rows.filter((h) => !h.skip && !h.added).length;
  const added = rows.filter((h) => h.added).length;

  return (
    <div className="rounded-xl bg-zinc-950/60 border border-zinc-800 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 p-3.5">
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-left cursor-pointer">
          <span className="text-zinc-200 font-semibold">🗣 Pronunciation</span>
          <span className="text-zinc-400">
            {!hints
              ? ' · not checked yet'
              : rows.length === 0
                ? ' · no hard names found'
                : ` · ${rows.length} name${rows.length === 1 ? '' : 's'} the voice may get wrong${pending ? `, ${pending} to add on approval` : ''}${added ? `, ${added} added` : ''}`}
          </span>
          {rows.length > 0 && <span className="text-zinc-500"> · {open ? 'Hide' : 'Show'}</span>}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            request('finding', 'POST', { beats: beats.map((b) => ({ text: b.text })) });
          }}
          disabled={busy !== null}
          className={smallButton}
        >
          {busy === 'finding' ? 'Looking…' : hints ? 'Find names again' : 'Find hard names'}
        </button>
      </div>

      {open && rows.length > 0 && (
        <div className="border-t border-zinc-800 p-3.5 space-y-2">
          <p className="text-zinc-500">
            Ticked names are added to your{' '}
            <Link href="/narrators" className="underline text-indigo-300">
              pronunciation list
            </Link>{' '}
            when you approve the script, so the voice reads the respelling. Captions keep the real spelling. Capitals mark
            the stressed syllable.
          </p>
          <ul className="space-y-1.5">
            {rows.map((h, i) => (
              <li key={h.term} className="flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  checked={!h.skip}
                  disabled={h.added}
                  onChange={(e) => change(i, { skip: !e.target.checked })}
                  className="accent-indigo-500"
                />
                <span className={`w-36 truncate font-semibold ${h.skip ? 'text-zinc-500 line-through' : 'text-zinc-200'}`} title={h.term}>
                  {h.term}
                </span>
                <input
                  value={h.say}
                  disabled={h.added}
                  onChange={(e) => change(i, { say: e.target.value })}
                  className="flex-1 min-w-40 px-2 py-1 bg-zinc-950 border border-zinc-800 rounded-md text-zinc-100 font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                />
                {h.added ? (
                  <span className="text-emerald-400">✓ in list</span>
                ) : (
                  h.note && <span className="text-zinc-500">{h.note}</span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => request('saving', 'PUT', { hints: rows })}
              disabled={busy !== null || !dirty}
              className={smallButton}
            >
              {busy === 'saving' ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
            <button
              type="button"
              onClick={async () => {
                const data = await request('adding', 'PUT', { hints: rows, addNow: true });
                if (data) setMessage(`Added ${data.added} to your pronunciation list.`);
              }}
              disabled={busy !== null || pending === 0}
              className={smallButton}
            >
              {busy === 'adding' ? 'Adding…' : 'Add ticked now'}
            </button>
          </div>
        </div>
      )}
      {message && <p className="px-3.5 pb-3 text-zinc-400">{message}</p>}
    </div>
  );
}
