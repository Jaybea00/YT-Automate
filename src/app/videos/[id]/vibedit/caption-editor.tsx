'use client';

import React, { useCallback, useEffect, useState } from 'react';

interface CaptionEdit {
  basis: string[];
  fixes?: Record<number, string>;
  breaks?: number[];
  emphasis?: number[];
  hidden?: boolean;
}

interface CaptionBeat {
  index: number;
  words: string[];
  timed: boolean;
  edit: CaptionEdit | null;
  stale: boolean;
}

const blank = (words: string[]): CaptionEdit => ({ basis: words });
const toggle = (list: number[] | undefined, i: number) => {
  const set = new Set(list ?? []);
  if (set.has(i)) set.delete(i);
  else set.add(i);
  return [...set].sort((a, b) => a - b);
};

/**
 * The caption editor for one beat: click a word to fix how it's shown, keep it in the accent
 * colour, or start a new caption line there; or hide the beat's captions. Applies on the next
 * render (assembly or quick preview), and the word fixes go into the subtitle files too.
 */
export function CaptionEditor({ videoId, beatIndex }: { videoId: string; beatIndex: number }) {
  const [beat, setBeat] = useState<CaptionBeat | null>(null);
  const [draft, setDraft] = useState<CaptionEdit | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const fetchBeat = useCallback(
    () =>
      fetch(`/api/videos/${videoId}/captions`)
        .then((r) => r.json())
        .then((b: { beats?: CaptionBeat[] }) => b.beats?.[beatIndex] ?? null),
    [videoId, beatIndex],
  );

  useEffect(() => {
    let cancelled = false;
    fetchBeat()
      .then((b) => {
        if (cancelled || !b) return;
        setBeat(b);
        setDraft(b.edit && !b.stale ? b.edit : blank(b.words));
        setSelected(null);
        setStatus(null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchBeat]);

  if (!beat || !draft) return <p className="text-[11px] text-zinc-500">Loading captions…</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(beat.edit && !beat.stale ? beat.edit : blank(beat.words));
  const shown = (i: number) => draft.fixes?.[i] ?? beat.words[i];

  async function save(edit: CaptionEdit | null) {
    setStatus('Saving…');
    const res = await fetch(`/api/videos/${videoId}/captions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beat: beatIndex, edit }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setStatus(body.error || 'Could not save');
    setBeat(body.beat);
    setDraft(body.beat.edit ?? blank(body.beat.words));
    setStatus('Saved: shows on the next render or preview.');
  }

  const setFix = (i: number, value: string) => {
    const fixes = { ...(draft.fixes ?? {}) };
    if (value === beat.words[i]) delete fixes[i];
    else fixes[i] = value;
    setDraft({ ...draft, fixes: Object.keys(fixes).length ? fixes : undefined });
  };

  return (
    <div className="space-y-2 text-xs">
      {beat.stale && <p className="text-amber-300 text-[11px]">This beat was re-voiced or rewritten since its captions were edited; the old edits no longer apply.</p>}
      {!beat.timed && <p className="text-zinc-500 text-[11px]">Not timed to the voice yet (captions are spread evenly until this beat is voiced).</p>}

      <label className="flex items-center gap-1.5 text-zinc-300">
        <input type="checkbox" checked={Boolean(draft.hidden)} onChange={(e) => setDraft({ ...draft, hidden: e.target.checked || undefined })} className="accent-indigo-500" />
        No captions on this beat (subtitle files keep them)
      </label>

      <div className={`flex flex-wrap gap-1 leading-6 ${draft.hidden ? 'opacity-40' : ''}`}>
        {beat.words.map((_, i) => {
          const fixed = draft.fixes?.[i] !== undefined;
          const dropped = fixed && !shown(i).trim();
          return (
            <React.Fragment key={i}>
              {draft.breaks?.includes(i) && <span className="w-full h-0" />}
              <button
                type="button"
                onClick={() => setSelected(selected === i ? null : i)}
                className={`px-1.5 rounded border ${
                  selected === i ? 'border-indigo-400 bg-indigo-950' : 'border-zinc-800 bg-zinc-950 hover:border-zinc-600'
                } ${draft.emphasis?.includes(i) ? 'text-amber-300 font-semibold' : 'text-zinc-200'} ${dropped ? 'line-through text-zinc-600' : ''}`}
                title={fixed ? `was “${beat.words[i]}”` : undefined}
              >
                {dropped ? beat.words[i] : shown(i)}
                {fixed && !dropped && <span className="text-indigo-400">*</span>}
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {selected !== null && (
        <div className="flex flex-wrap items-center gap-1.5 p-2 rounded-lg bg-zinc-950 border border-zinc-800">
          <input
            value={shown(selected)}
            onChange={(e) => setFix(selected, e.target.value)}
            placeholder="(empty: leave this word out)"
            className="w-36 bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
          />
          <button type="button" onClick={() => setDraft({ ...draft, emphasis: toggle(draft.emphasis, selected) })} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">
            {draft.emphasis?.includes(selected) ? '★ Unhighlight' : '★ Highlight'}
          </button>
          {selected > 0 && (
            <button type="button" onClick={() => setDraft({ ...draft, breaks: toggle(draft.breaks, selected) })} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">
              {draft.breaks?.includes(selected) ? '↵ Join line' : '↵ New line here'}
            </button>
          )}
          {draft.fixes?.[selected] !== undefined && (
            <button type="button" onClick={() => setFix(selected, beat.words[selected])} className="px-2 py-1 rounded text-zinc-400 hover:text-zinc-100">
              Reset word
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => save(draft)}
          disabled={!dirty}
          className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium"
        >
          Save captions
        </button>
        {(beat.edit || dirty) && (
          <button type="button" onClick={() => save(null)} className="px-2 py-1.5 text-zinc-400 hover:text-zinc-100">
            Reset all
          </button>
        )}
        {status && <span className="text-[11px] text-zinc-400">{status}</span>}
      </div>
    </div>
  );
}
