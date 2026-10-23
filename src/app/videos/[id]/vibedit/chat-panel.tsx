'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface Change {
  beat: number;
  shot: number;
  action: 'footage' | 'redo' | 'text';
  query?: string;
  archive?: boolean;
  reason: string;
  now?: string;
}

interface Result {
  beat: number;
  shot: number;
  ok: boolean;
  shows?: string;
  error?: string;
}

interface Snapshot {
  id: string;
  createdAt: string;
  label: string;
  beats: number[];
}

type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; changes?: Change[]; picked?: boolean[]; state?: 'planned' | 'applying' | 'applied' | 'discarded'; results?: Result[]; snapshotId?: string };

const EXAMPLES = ['Replace the text cards in chapter 2 with footage', 'Find a better shot for beat 12', 'Redo every flagged shot'];

function describeChange(c: Change): string {
  if (c.action === 'footage') return `${c.archive ? 'archive footage' : 'footage'} of “${c.query}”`;
  if (c.action === 'text') return 'the narration as animated type';
  return 'a fresh pick of the same idea';
}

/**
 * Chat with the editor about the visuals: each request comes back as a list of shot changes to
 * tick and apply. Every applied request can be undone.
 */
export function ChatPanel({ videoId, onApplied, onJumpToBeat }: { videoId: string; onApplied: () => void; onJumpToBeat: (index: number) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const fetchSnapshots = useCallback(
    () => fetch(`/api/videos/${videoId}/vibedit/undo`).then((r) => r.json()) as Promise<{ snapshots?: Snapshot[] }>,
    [videoId],
  );
  useEffect(() => {
    let cancelled = false;
    fetchSnapshots()
      .then((b) => {
        if (!cancelled) setSnapshots(b.snapshots ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchSnapshots]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages]);

  const update = (i: number, patch: Partial<Extract<Message, { role: 'assistant' }>>) =>
    setMessages((prev) => prev.map((m, n) => (n === i && m.role === 'assistant' ? { ...m, ...patch } : m)));

  async function send(text = input) {
    const message = text.trim();
    if (!message || thinking) return;
    setError(null);
    setInput('');
    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, { role: 'user', text: message }]);
    setThinking(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/vibedit/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'The editor could not plan that');
      const changes: Change[] = body.changes ?? [];
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: body.reply, changes, picked: changes.map(() => true), state: changes.length ? 'planned' : undefined },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setThinking(false);
    }
  }

  async function apply(i: number) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.changes) return;
    const changes = m.changes.filter((_, n) => m.picked?.[n]);
    if (!changes.length) return;
    const request = [...messages.slice(0, i)].reverse().find((x) => x.role === 'user')?.text ?? 'Chat edit';
    update(i, { state: 'applying' });
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/vibedit/chat/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes, label: request }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not apply the changes');
      update(i, { state: 'applied', results: body.results, snapshotId: body.snapshotId });
      setSnapshots((await fetchSnapshots()).snapshots ?? []);
      onApplied();
    } catch (err) {
      update(i, { state: 'planned' });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function undo(snapshotId: string) {
    setError(null);
    const res = await fetch(`/api/videos/${videoId}/vibedit/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error || 'Could not undo');
    setSnapshots(body.snapshots ?? []);
    setMessages((prev) => [
      ...prev.map((m) => (m.role === 'assistant' && m.snapshotId === snapshotId ? { ...m, snapshotId: undefined } : m)),
      { role: 'assistant', text: `Undone: beat${body.restored.length === 1 ? '' : 's'} ${body.restored.map((b: number) => b + 1).join(', ')} are back as they were.` },
    ]);
    onApplied();
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-bold text-zinc-300 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
          <span>💬</span> Chat editor · visuals
        </span>
        {snapshots[0] && (
          <button onClick={() => undo(snapshots[0].id)} className="text-[11px] text-zinc-400 hover:text-zinc-100" title={snapshots[0].label}>
            ↶ Undo last edit
          </button>
        )}
      </div>

      <div className="max-h-96 overflow-y-auto space-y-2.5 text-xs">
        {messages.length === 0 && (
          <div className="space-y-1.5">
            <p className="text-zinc-500">Say what to change in the pictures. You&apos;ll see the exact changes before anything happens.</p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((e) => (
                <button key={e} onClick={() => send(e)} className="px-2 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-300 hover:border-zinc-600">
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="ml-8 p-2.5 rounded-xl bg-indigo-950/70 border border-indigo-800/60 text-indigo-100">
              {m.text}
            </div>
          ) : (
            <div key={i} className="mr-8 p-2.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2">
              <p className="text-zinc-200">{m.text}</p>
              {m.changes && m.changes.length > 0 && (
                <ul className="space-y-1.5">
                  {m.changes.map((c, n) => {
                    const result = m.results?.find((r) => r.beat === c.beat && r.shot === c.shot);
                    return (
                      <li key={n} className="flex items-start gap-2">
                        {m.state === 'planned' && (
                          <input
                            type="checkbox"
                            checked={m.picked?.[n] ?? true}
                            onChange={(e) => update(i, { picked: m.changes!.map((_, k) => (k === n ? e.target.checked : m.picked?.[k] ?? true)) })}
                            className="mt-0.5 accent-indigo-500"
                          />
                        )}
                        {result && <span>{result.ok ? '✅' : '⚠️'}</span>}
                        <div className="min-w-0">
                          <button onClick={() => onJumpToBeat(c.beat)} className="font-semibold text-indigo-300 hover:underline">
                            Beat {c.beat + 1} · shot {c.shot + 1}
                          </button>
                          <span className="text-zinc-300">: {describeChange(c)}</span>
                          {c.now && <p className="text-[11px] text-zinc-500">now {c.now}{c.reason ? ` · ${c.reason}` : ''}</p>}
                          {result && !result.ok && <p className="text-[11px] text-red-300">Not changed: {result.error}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {m.state === 'planned' && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => apply(i)}
                    disabled={!m.picked?.some(Boolean)}
                    className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium"
                  >
                    Apply {m.picked?.filter(Boolean).length ?? 0} change{m.picked?.filter(Boolean).length === 1 ? '' : 's'}
                  </button>
                  <button onClick={() => update(i, { state: 'discarded' })} className="px-3 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-100">
                    Discard
                  </button>
                </div>
              )}
              {m.state === 'applying' && <p className="text-amber-300">Applying… each shot is searched, checked and rendered (up to a minute each).</p>}
              {m.state === 'discarded' && <p className="text-zinc-500">Discarded: nothing changed.</p>}
              {m.state === 'applied' && (
                <div className="flex items-center gap-3">
                  <p className="text-emerald-300">
                    Done: {m.results?.filter((r) => r.ok).length} of {m.results?.length} changed. Re-assemble to see it in the master.
                  </p>
                  {m.snapshotId && (
                    <button onClick={() => undo(m.snapshotId!)} className="text-zinc-400 hover:text-zinc-100 whitespace-nowrap">
                      ↶ Undo
                    </button>
                  )}
                </div>
              )}
            </div>
          ),
        )}
        {thinking && <p className="text-zinc-500">Looking through the shots…</p>}
        <div ref={endRef} />
      </div>

      {error && <p className="text-xs text-red-300">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. use old film of the docks in beat 4"
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100"
        />
        <button type="submit" disabled={thinking || !input.trim()} className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40 text-xs">
          Send
        </button>
      </form>
    </div>
  );
}
