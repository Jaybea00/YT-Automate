'use client';

import React, { useState } from 'react';
import type { VideoRecord } from '@/lib/types/video';
import type { OutlineChapter, ScriptOutline } from '@/lib/script/outline';
import { ResearchPanel } from './research-panel';
import { PackagingPicker } from './packaging-card';
import type { Packaging } from '@/lib/script/packaging-types';

const inputClass =
  'w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 text-sm';
const smallButton =
  'px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-xs cursor-pointer disabled:opacity-40 disabled:cursor-default';

/** Points are edited one per line. */
const toLines = (points: string[]) => points.join('\n');
const fromLines = (text: string) => text.split('\n');

/**
 * Brief mode: the outline drafted from the creator's brief, editable before the full script is
 * written. Chapters can be renamed, reordered, added and removed; points are one per line.
 */
export function OutlineEditor({ video, onWritten }: { video: VideoRecord; onWritten: (video: VideoRecord) => void }) {
  const sj = video.script_json!;
  const [outline, setOutline] = useState<ScriptOutline>(sj.outline!);
  const [research, setResearch] = useState(sj.research);
  const [packaging, setPackaging] = useState<Packaging | undefined>(sj.packaging);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | 'saving' | 'redrafting' | 'writing'>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [showBrief, setShowBrief] = useState(false);

  const update = (next: ScriptOutline) => {
    setOutline(next);
    setDirty(true);
  };
  const updateChapter = (i: number, patch: Partial<OutlineChapter>) =>
    update({ ...outline, chapters: outline.chapters.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const moveChapter = (i: number, by: number) => {
    const chapters = [...outline.chapters];
    const [moved] = chapters.splice(i, 1);
    chapters.splice(i + by, 0, moved);
    update({ ...outline, chapters });
  };

  // Blank lines are kept while typing; the server drops them
  const cleaned = (): ScriptOutline => ({
    ...outline,
    chapters: outline.chapters.map((c) => ({ ...c, points: c.points.map((p) => p.trim()).filter(Boolean) })),
  });

  async function call(kind: 'saving' | 'redrafting' | 'writing', url: string, method: string, body: unknown) {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const data = await call('saving', `/api/videos/${video.id}/script/outline`, 'PUT', { outline: cleaned() });
    if (data) {
      setOutline(data.outline);
      setDirty(false);
    }
  }

  async function redraft() {
    if (dirty && !window.confirm('Drafting again replaces your edits to this outline. Continue?')) return;
    const data = await call('redrafting', `/api/videos/${video.id}/script/outline`, 'POST', { notes });
    if (data) {
      setOutline(data.outline);
      setResearch(data.research ?? undefined);
      setDirty(false);
      setNotes('');
    }
  }

  async function write() {
    const data = await call('writing', `/api/videos/${video.id}/script/write`, 'POST', { outline: cleaned(), packaging });
    if (data) onWritten(data);
  }

  const extras = sj.brief_extras;
  const hasExtras = Boolean(extras && (extras.title_ideas.length || extras.thumbnail_ideas.length || extras.sources.length));
  const pointCount = outline.chapters.reduce((n, c) => n + c.points.filter((p) => p.trim()).length, 0);

  return (
    <div className="space-y-6">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">Outline from your brief</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              {outline.chapters.length} chapters · {pointCount} points. Edit anything, then write the full script. It
              follows this outline in order.
            </p>
          </div>
          <button type="button" onClick={() => setShowBrief((v) => !v)} className={smallButton}>
            {showBrief ? 'Hide' : 'Show'} your brief
          </button>
        </div>

        {showBrief && (
          <pre className="whitespace-pre-wrap text-xs text-zinc-400 bg-zinc-950/70 border border-zinc-800 rounded-lg p-3 max-h-64 overflow-y-auto">
            {sj.brief}
          </pre>
        )}

        <div>
          <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">Hook (cold open)</label>
          <textarea
            rows={2}
            value={outline.hook}
            onChange={(e) => update({ ...outline, hook: e.target.value })}
            className={inputClass}
          />
        </div>

        <ol className="space-y-4">
          {outline.chapters.map((chapter, i) => (
            <li key={i} className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-zinc-500 w-6 shrink-0">{i + 1}.</span>
                <input
                  value={chapter.title}
                  onChange={(e) => updateChapter(i, { title: e.target.value })}
                  placeholder="Chapter title"
                  className={`${inputClass} font-semibold`}
                />
                <button type="button" title="Move up" disabled={i === 0} onClick={() => moveChapter(i, -1)} className={smallButton}>
                  ↑
                </button>
                <button
                  type="button"
                  title="Move down"
                  disabled={i === outline.chapters.length - 1}
                  onClick={() => moveChapter(i, 1)}
                  className={smallButton}
                >
                  ↓
                </button>
                <button
                  type="button"
                  title="Remove chapter"
                  disabled={outline.chapters.length === 1}
                  onClick={() => update({ ...outline, chapters: outline.chapters.filter((_, j) => j !== i) })}
                  className={smallButton}
                >
                  ✕
                </button>
              </div>
              <textarea
                rows={Math.max(2, chapter.points.length)}
                value={toLines(chapter.points)}
                onChange={(e) => updateChapter(i, { points: fromLines(e.target.value) })}
                placeholder="One point per line"
                className={`${inputClass} text-xs leading-relaxed`}
              />
              {chapter.fact_ids?.length ? (
                <p className="text-[11px] text-zinc-500">
                  Facts:{' '}
                  {chapter.fact_ids.map((fid) => {
                    const fact = research?.facts.find((f) => f.id === fid);
                    return (
                      <span key={fid} title={fact?.claim} className="font-mono text-indigo-300 mr-1.5">
                        {fid}
                      </span>
                    );
                  })}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={() => update({ ...outline, chapters: [...outline.chapters, { title: '', points: [''] }] })}
          className={smallButton}
        >
          + Add chapter
        </button>

        <div>
          <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">Closing</label>
          <textarea
            rows={2}
            value={outline.closing}
            onChange={(e) => update({ ...outline, closing: e.target.value })}
            className={inputClass}
          />
        </div>

        {packaging && packaging.options.length > 0 && <PackagingPicker packaging={packaging} onChange={setPackaging} />}

        {hasExtras && extras && (
          <div className="p-3 rounded-lg bg-zinc-950/60 border border-zinc-800 text-xs text-zinc-400 space-y-1">
            <p className="text-zinc-300 font-semibold">Saved from your brief for publishing</p>
            {extras.title_ideas.length > 0 && <p>Title ideas: {extras.title_ideas.join(' · ')}</p>}
            {extras.thumbnail_ideas.length > 0 && <p>Thumbnail ideas: {extras.thumbnail_ideas.join(' · ')}</p>}
            {extras.sources.length > 0 && <p>Sources for the description: {extras.sources.length}</p>}
          </div>
        )}

        {error && (
          <div className="p-3 rounded-lg bg-red-950/50 border border-red-800 text-red-200 text-xs">{error}</div>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="button"
            onClick={write}
            disabled={busy !== null}
            className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-indigo-600 hover:from-red-500 hover:to-indigo-500 text-white font-semibold text-sm disabled:opacity-50 cursor-pointer"
          >
            {busy === 'writing' ? 'Writing the script… (a few minutes)' : 'Write the full script →'}
          </button>
          <button type="button" onClick={save} disabled={busy !== null || !dirty} className={`${smallButton} py-2`}>
            {busy === 'saving' ? 'Saving…' : dirty ? 'Save outline' : 'Saved'}
          </button>
        </div>

        <div className="pt-3 border-t border-zinc-800 space-y-2">
          <label className="block text-xs text-zinc-400">Or draft the outline again, optionally saying what to change</label>
          <div className="flex gap-2">
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. More on his time at City, fewer chapters on childhood"
              className={inputClass}
            />
            <button type="button" onClick={redraft} disabled={busy !== null} className={`${smallButton} shrink-0 px-3`}>
              {busy === 'redrafting' ? 'Drafting…' : 'Draft again'}
            </button>
          </div>
        </div>
      </div>

      <ResearchPanel research={research} beats={[]} beforeScript />
    </div>
  );
}
