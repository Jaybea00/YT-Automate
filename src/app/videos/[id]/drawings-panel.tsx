'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScriptBeat } from '@/lib/script/generate-script';
import { drawingCode, parseDrawingCode } from '@/lib/stickman/drawing-codes';

const smallButton =
  'px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 cursor-pointer disabled:opacity-50 disabled:cursor-default';

interface BriefRow {
  code: string;
  beat: number;
  shot: number;
  narration: string;
  scene: string;
  framing: string;
  mood: string;
  characters: string[];
  label?: string;
  bubble?: string;
}

interface UploadResult {
  name: string;
  status: 'waiting' | 'sending' | 'placed' | 'filed' | 'failed';
  message?: string;
}

const csvCell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The drawing brief for a stickman video: every picture to draw, with its code, the line it plays
 * under, the scene, framing, mood and characters, and whether its drawing has arrived. Drawings
 * named with their code ("B05_S2.png") are dropped here and go straight into their shot. On the
 * review page it also sets the drawing budget (how many drawings the brief plans).
 */
export function DrawingsPanel({
  videoId,
  beats,
  showBudget = false,
  savedBudget,
  onBeats,
  onDrawingsChanged,
  bibleTranslation,
}: {
  videoId: string;
  beats: ScriptBeat[];
  showBudget?: boolean;
  savedBudget?: number | null;
  onBeats?: (beats: ScriptBeat[]) => void;
  onDrawingsChanged?: () => void;
  /** Bible stories: the verse cards' edition, chosen here (absent for other stickman styles). */
  bibleTranslation?: 'webbe' | 'web';
}) {
  const [open, setOpen] = useState(false);
  const [filed, setFiled] = useState<Set<string>>(new Set());
  const [budget, setBudget] = useState<string>(savedBudget ? String(savedBudget) : '');
  const [planning, setPlanning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadResult[]>([]);
  const [dragging, setDragging] = useState(false);
  const [translation, setTranslation] = useState<'webbe' | 'web' | undefined>(bibleTranslation);
  // Drawings dropped without codes, and the codes proposed for them (checked before placing)
  const [pending, setPending] = useState<File[] | null>(null);
  const [proposals, setProposals] = useState<Array<{ name: string; code: string; file?: File; fileId?: string; reason?: string }> | null>(null);
  const [proposalMode, setProposalMode] = useState<'order' | 'picture' | null>(null);
  const [matching, setMatching] = useState(false);
  const [noting, setNoting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const rows = useMemo<BriefRow[]>(
    () =>
      beats.flatMap((b) =>
        (b.shots ?? []).flatMap((s, i) =>
          s.visual_type === 'drawing'
            ? [
                {
                  code: drawingCode(b.index, i),
                  beat: b.index + 1,
                  shot: i + 1,
                  narration: s.covers,
                  scene: s.drawing?.scene ?? s.visual_query,
                  framing: s.drawing?.framing ?? 'medium',
                  mood: s.drawing?.mood ?? 'neutral',
                  characters: s.drawing?.characters ?? [],
                  label: s.drawing?.label?.text,
                  bubble: s.drawing?.bubble?.text,
                },
              ]
            : [],
        ),
      ),
    [beats],
  );
  const characters = useMemo(() => [...new Set(rows.flatMap((r) => r.characters))].sort(), [rows]);
  const drawn = rows.filter((r) => filed.has(r.code)).length;
  const labelled = rows.some((r) => r.label || r.bubble);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/videos/${videoId}/drawings`).catch(() => null);
    const data = res?.ok ? ((await res.json()) as { filed: string[] }) : null;
    if (data) setFiled(new Set(data.filed));
  }, [videoId]);
  useEffect(() => {
    let live = true;
    fetch(`/api/videos/${videoId}/drawings`)
      .then((res) => (res.ok ? (res.json() as Promise<{ filed: string[] }>) : null))
      .then((data) => {
        if (live && data) setFiled(new Set(data.filed));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [videoId, beats]);

  /** Labels and speech bubbles on the existing brief (shots and codes stay as they are). */
  async function addNotes() {
    setNoting(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/drawings/notes`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Adding labels failed (${res.status})`);
      onBeats?.(data.beats);
      onDrawingsChanged?.();
      setOpen(true);
      setMessage(
        `Added ${data.labels} label${data.labels === 1 ? '' : 's'} and ${data.bubbles} speech bubble${data.bubbles === 1 ? '' : 's'}. They appear once the visuals are rendered again (drawings already uploaded stay where they are).`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setNoting(false);
    }
  }

  async function replan() {
    const n = Number(budget);
    setPlanning(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/script/shots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drawingBudget: Number.isFinite(n) && n > 0 ? n : 0 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Re-planning failed (${res.status})`);
      onBeats?.(data.beats);
      setMessage('The brief was planned again. Codes may have changed: download it again before drawing.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanning(false);
    }
  }

  /**
   * Dropped drawings: files named with their codes go straight in; otherwise the creator chooses
   * to place them in order (file names sorted) or by picture (the AI matches each to its scene),
   * and checks the proposed codes before anything is placed.
   */
  function sendFiles(files: File[]) {
    const images = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
    if (images.length === 0) return;
    setOpen(true);
    setMessage(null);
    setProposals(null);
    if (images.every((f) => parseDrawingCode(f.name))) {
      uploadCoded(images.map((file) => ({ file, code: drawingCode(parseDrawingCode(file.name)!.beat_index, parseDrawingCode(file.name)!.shot_index) })));
      return;
    }
    setPending(images);
  }

  /** Uploads drawings one at a time (each renders into its beat), showing progress. */
  async function uploadCoded(items: Array<{ file: File; code: string }>) {
    const list: UploadResult[] = items.map((it) => ({ name: it.file.name, status: 'waiting' }));
    setUploads(list);
    for (const [i, item] of items.entries()) {
      list[i] = { ...list[i], status: 'sending' };
      setUploads([...list]);
      try {
        const form = new FormData();
        form.append('file', item.file);
        form.append('code', item.code);
        const res = await fetch(`/api/videos/${videoId}/drawings`, { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
        list[i] = { ...list[i], status: data.placed ? 'placed' : 'filed', message: data.placed ? `${data.code} is in the video` : `${data.code} is filed; it goes in when the visuals stage runs` };
      } catch (err) {
        list[i] = { ...list[i], status: 'failed', message: err instanceof Error ? err.message : String(err) };
      }
      setUploads([...list]);
    }
    await refresh();
    onDrawingsChanged?.();
  }

  /** In order: file names sorted the way people number them (2 before 10), first file to the first drawing. */
  function placeInOrder() {
    if (!pending) return;
    const sorted = [...pending].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    setProposals(sorted.slice(0, rows.length).map((file, i) => ({ name: file.name, code: rows[i].code, file })));
    setProposalMode('order');
    const extra = sorted.length - rows.length;
    setMessage(
      extra > 0
        ? `${extra} more file${extra === 1 ? '' : 's'} than drawings in the brief: the last ${extra === 1 ? 'one is' : `${extra} are`} left out.`
        : extra < 0
          ? `${-extra} drawing${extra === -1 ? '' : 's'} in the brief will still be missing (the last ones).`
          : null,
    );
  }

  /** By picture: the files are staged, the AI matches each to the scene it shows, and the creator checks the list. */
  async function placeByPicture() {
    if (!pending) return;
    setMatching(true);
    setMessage(null);
    try {
      const staged: Array<{ id: string; name: string }> = [];
      for (const [i, file] of pending.entries()) {
        setMessage(`Preparing drawings ${i + 1} of ${pending.length}…`);
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/videos/${videoId}/batch-match/stage`, { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Could not prepare ${file.name}`);
        staged.push({ id: data.id, name: file.name });
      }
      setMessage(`Looking at ${staged.length} drawings and matching them to the brief (about a minute per 36 drawings)…`);
      const res = await fetch(`/api/videos/${videoId}/batch-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: staged.map((s) => s.id) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Matching failed (${res.status})`);
      const matches = (data.matches ?? []) as Array<{ fileId: string; fileName: string; beat_index: number; shot_index: number | null; reason: string }>;
      const placed = matches.filter((m) => m.shot_index !== null);
      setProposals(placed.map((m) => ({ name: m.fileName, code: drawingCode(m.beat_index, m.shot_index!), fileId: m.fileId, reason: m.reason })));
      setProposalMode('picture');
      const unmatched = staged.filter((s) => !placed.some((m) => m.fileId === s.id)).map((s) => s.name);
      setMessage(
        unmatched.length
          ? `${unmatched.length} drawing${unmatched.length === 1 ? '' : 's'} didn't clearly match a scene: ${unmatched.slice(0, 10).join(', ')}${unmatched.length > 10 ? '…' : ''}. Give ${unmatched.length === 1 ? 'it' : 'them'} a code by hand below if you want ${unmatched.length === 1 ? 'it' : 'them'} in.`
          : null,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setMatching(false);
    }
  }

  /** Places the checked list: uploads by code (in order) or applies the staged matches (by picture). */
  async function confirmProposals() {
    if (!proposals) return;
    const valid = proposals.filter((p) => rows.some((r) => r.code === p.code.toUpperCase()));
    setPending(null);
    setProposals(null);
    if (proposalMode === 'order') {
      await uploadCoded(valid.map((p) => ({ file: p.file!, code: p.code.toUpperCase() })));
      return;
    }
    const list: UploadResult[] = valid.map((p) => ({ name: p.name, status: 'sending' }));
    setUploads(list);
    try {
      const res = await fetch(`/api/videos/${videoId}/batch-match/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          license_type: 'own_work',
          matches: valid.map((p) => ({ fileId: p.fileId, ...parseDrawingCode(p.code)! })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Placing failed (${res.status})`);
      const results = (data.results ?? []) as Array<{ ok: boolean; error?: string; filed?: boolean }>;
      setUploads(
        valid.map((p, i) => ({
          name: p.name,
          status: results[i]?.ok ? (results[i].filed ? 'filed' : 'placed') : 'failed',
          message: results[i]?.ok ? `${p.code.toUpperCase()} ${results[i].filed ? 'is filed; it goes in when the visuals stage runs' : 'is in the video'}` : results[i]?.error,
        })),
      );
    } catch (err) {
      setUploads(list.map((u) => ({ ...u, status: 'failed', message: err instanceof Error ? err.message : String(err) })));
    }
    await refresh();
    onDrawingsChanged?.();
  }

  async function chooseTranslation(next: 'webbe' | 'web') {
    setTranslation(next);
    const res = await fetch(`/api/videos/${videoId}/drawings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bibleTranslation: next }),
    }).catch(() => null);
    if (!res?.ok) setMessage('Could not save the translation; try again.');
  }

  function downloadCsv() {
    const header = ['Code', 'Beat', 'Shot', 'Narration', 'Draw this', 'Framing', 'Mood', 'Characters', 'Drawn'];
    const lines = rows.map((r) => [r.code, r.beat, r.shot, r.narration, r.scene, r.framing, r.mood, r.characters.join(', '), filed.has(r.code) ? 'yes' : ''].map(csvCell).join(','));
    const blob = new Blob([[header.map(csvCell).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'drawing-brief.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function printBrief() {
    const w = window.open('', '_blank');
    if (!w) return;
    const body = rows
      .map(
        (r) =>
          `<tr><td class="code">${r.code}</td><td><b>${escapeHtml(r.scene)}</b><div class="meta">${r.framing} · ${r.mood}${r.characters.length ? ` · ${escapeHtml(r.characters.join(', '))}` : ''}</div><div class="line">“${escapeHtml(r.narration)}”</div></td><td class="box">${filed.has(r.code) ? '✓' : ''}</td></tr>`,
      )
      .join('');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Drawing brief</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}.sub{color:#555;margin-bottom:16px}
table{border-collapse:collapse;width:100%}td{border-top:1px solid #ccc;padding:8px 6px;vertical-align:top}
.code{font:700 15px ui-monospace,monospace;white-space:nowrap;width:80px}.meta{color:#555;font-size:12px;margin-top:2px}.line{color:#333;font-style:italic;margin-top:4px}
.box{width:28px;height:28px;border:2px solid #333;text-align:center;font-weight:700}tr{page-break-inside:avoid}</style>
<h1>Drawing brief: ${rows.length} drawings</h1><div class="sub">Name each file with its code, e.g. ${rows[0]?.code ?? 'B01_S1'}.png${characters.length ? ` · Characters: ${escapeHtml(characters.join(', '))}` : ''}</div>
<table>${body}</table><script>window.onload=()=>window.print()</script>`);
    w.document.close();
  }

  if (rows.length === 0) {
    // No brief yet (a pasted script, or planning that didn't run): offer to plan it here
    return (
      <div className="rounded-xl bg-zinc-950/60 border border-amber-500/40 text-xs p-3.5 space-y-2">
        <div className="text-zinc-200 font-semibold">✏️ Drawing brief · not planned yet</div>
        <p className="text-zinc-400">
          This script has no drawing brief yet. Plan it to get the list of pictures to draw, each with its code. Set how many drawings
          you want to make, or leave it empty for the style&apos;s own pace (a new drawing every few seconds).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-zinc-300" htmlFor="drawing-budget-new">
            Drawings I want to make
          </label>
          <input
            id="drawing-budget-new"
            type="number"
            min={0}
            max={400}
            value={budget}
            placeholder="style's pace"
            onChange={(e) => setBudget(e.target.value)}
            className="w-24 px-2 py-1 bg-zinc-950 border border-zinc-800 rounded-md text-zinc-100 focus:outline-none focus:border-indigo-500"
          />
          <button type="button" onClick={replan} disabled={planning} className={smallButton}>
            {planning ? 'Planning… (about a minute per 12 beats)' : 'Plan the drawing brief'}
          </button>
        </div>
        {message && <div className="p-2 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300">{message}</div>}
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl bg-zinc-950/60 border text-xs ${dragging ? 'border-indigo-500' : 'border-zinc-800'}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        sendFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 p-3.5">
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-left cursor-pointer">
          <span className="text-zinc-200 font-semibold">✏️ Drawing brief</span>
          <span className="text-zinc-400">
            {' '}
            · {rows.length} drawing{rows.length === 1 ? '' : 's'} · {drawn} drawn{drawn < rows.length ? `, ${rows.length - drawn} to go` : ' ✓'}
          </span>
          <span className="text-zinc-500"> · {open ? 'Hide' : 'Show'}</span>
        </button>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={downloadCsv} className={smallButton}>
            Download CSV
          </button>
          <button type="button" onClick={printBrief} className={smallButton}>
            Print
          </button>
          <button
            type="button"
            onClick={addNotes}
            disabled={noting}
            className={smallButton}
            title="The AI picks a few places for a name label with an arrow, or a speech bubble with a character's quoted words. Codes don't change."
          >
            {noting ? 'Adding…' : labelled ? 'Redo labels & bubbles' : 'Add labels & bubbles'}
          </button>
          <button type="button" onClick={() => inputRef.current?.click()} className={smallButton}>
            Upload drawings
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              sendFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {open && (
        <div className="border-t border-zinc-800 p-3.5 space-y-3">
          <p className="text-zinc-500">
            Drop your drawings anywhere on this panel. Files named with their code (<span className="font-mono text-zinc-300">B05_S2.png</span>)
            go straight into their shot; any other names can be placed in order or matched by picture, and you check the list first. PNG
            with a transparent background blends best; white backgrounds work too. Until a drawing arrives, its line shows as doodle text.
          </p>
          {characters.length > 0 && (
            <p className="text-zinc-400">
              <span className="text-zinc-300 font-semibold">Characters:</span> {characters.join(' · ')}
            </p>
          )}

          {showBudget && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-zinc-300" htmlFor="drawing-budget">
                Drawings I want to make
              </label>
              <input
                id="drawing-budget"
                type="number"
                min={0}
                max={400}
                value={budget}
                placeholder="style's pace"
                onChange={(e) => setBudget(e.target.value)}
                className="w-24 px-2 py-1 bg-zinc-950 border border-zinc-800 rounded-md text-zinc-100 focus:outline-none focus:border-indigo-500"
              />
              <button type="button" onClick={replan} disabled={planning} className={smallButton}>
                {planning ? 'Planning…' : 'Plan the brief again'}
              </button>
              <span className="text-zinc-500">Leave empty for the style&apos;s own pace. Re-planning can change codes.</span>
            </div>
          )}

          {translation && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-zinc-300">Verse cards quote the World English Bible:</span>
              {([
                ['webbe', 'British Edition ("the LORD")'],
                ['web', 'Standard ("Yahweh")'],
              ] as const).map(([value, label]) => (
                <label key={value} className="flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                  <input type="radio" name="bible-translation" checked={translation === value} onChange={() => chooseTranslation(value)} className="accent-indigo-500" />
                  {label}
                </label>
              ))}
              <span className="text-zinc-500">Applies to verse cards rendered after the change.</span>
            </div>
          )}

          {message && <div className="p-2 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300">{message}</div>}

          {pending && !proposals && (
            <div className="p-3 rounded-lg bg-zinc-900 border border-indigo-500/40 space-y-2">
              <div className="text-zinc-200 font-semibold">
                {pending.length} drawing{pending.length === 1 ? '' : 's'} without codes in their names. How should they be placed?
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={placeInOrder} disabled={matching} className={smallButton}>
                  In order (sorted by file name)
                </button>
                <button type="button" onClick={placeByPicture} disabled={matching} className={smallButton}>
                  {matching ? 'Matching…' : 'By picture (the AI matches each to its scene)'}
                </button>
                <button type="button" onClick={() => setPending(null)} disabled={matching} className={smallButton}>
                  Cancel
                </button>
              </div>
              <p className="text-zinc-500">
                In order: the first file (1, 2, … 10, 11 sort as numbers) goes to {rows[0]?.code}, the next to {rows[1]?.code ?? 'the next drawing'}, and so on
                through the story. By picture works whatever the file names are. Either way you check the list before anything is placed.
              </p>
            </div>
          )}

          {proposals && (
            <div className="p-3 rounded-lg bg-zinc-900 border border-indigo-500/40 space-y-2">
              <div className="text-zinc-200 font-semibold">
                Check where each drawing goes ({proposals.length}) · change a code to move one
              </div>
              <ul className="max-h-96 overflow-y-auto divide-y divide-zinc-800/80">
                {proposals.map((p, i) => {
                  const row = rows.find((r) => r.code === p.code.toUpperCase());
                  return (
                    <li key={`${p.name}-${i}`} className="py-1.5 flex flex-wrap items-center gap-2">
                      <span className="w-48 truncate text-zinc-300" title={p.name}>
                        {p.name}
                      </span>
                      <span className="text-zinc-500">→</span>
                      <input
                        value={p.code}
                        onChange={(e) => setProposals((list) => list && list.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))}
                        className={`w-20 px-1.5 py-0.5 font-mono bg-zinc-950 border rounded ${row ? 'border-zinc-700 text-zinc-100' : 'border-amber-500 text-amber-300'}`}
                      />
                      <span className="text-zinc-500 truncate max-w-md" title={row?.scene}>
                        {row ? row.scene : 'not a drawing in this brief: it will be skipped'}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={confirmProposals} className={smallButton}>
                  Place {proposals.filter((p) => rows.some((r) => r.code === p.code.toUpperCase())).length} drawings
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProposals(null);
                    setPending(null);
                    setMessage(null);
                  }}
                  className={smallButton}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {uploads.length > 0 && (
            <ul className="space-y-1">
              {uploads.map((u, i) => (
                <li key={`${u.name}-${i}`} className="flex gap-2">
                  <span className="w-5">{u.status === 'placed' || u.status === 'filed' ? '✅' : u.status === 'failed' ? '⚠️' : u.status === 'sending' ? '⏳' : '·'}</span>
                  <span className="text-zinc-300 truncate max-w-56" title={u.name}>
                    {u.name}
                  </span>
                  {u.message && <span className={u.status === 'failed' ? 'text-amber-300' : 'text-zinc-500'}>{u.message}</span>}
                </li>
              ))}
            </ul>
          )}

          <ul className="divide-y divide-zinc-800/80">
            {rows.map((r) => (
              <li key={r.code} className="py-2 flex gap-3">
                <span className={`font-mono font-semibold w-16 shrink-0 ${filed.has(r.code) ? 'text-emerald-300' : 'text-zinc-200'}`}>
                  {filed.has(r.code) ? '✓ ' : ''}
                  {r.code}
                </span>
                <div className="min-w-0 space-y-0.5">
                  <div className="text-zinc-200">{r.scene}</div>
                  <div className="text-zinc-500">
                    {r.framing} · {r.mood}
                    {r.characters.length > 0 && ` · ${r.characters.join(', ')}`}
                  </div>
                  <div className="text-zinc-500 italic">“{r.narration}”</div>
                  {r.label && <div className="text-amber-300">🏷 Label: {r.label}</div>}
                  {r.bubble && <div className="text-sky-300">💬 Bubble: “{r.bubble}”</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
