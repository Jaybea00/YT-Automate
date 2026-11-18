'use client';

import React, { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ClipPlan, ClipProject, TextOverlay, VoiceLine } from '@/pipeline/clipping/types';

const STEPS = ['downloading', 'analyzing', 'writing', 'voicing', 'rendering'];
const terminal = (s?: string) => s === 'ready' || s === 'failed';

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm cursor-pointer" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-red-500" />
      <span>{label}</span>
    </label>
  );
}

function Num({ value, onChange, step = 0.1, className = 'w-20' }: { value: number; onChange: (v: number) => void; step?: number; className?: string }) {
  return (
    <input
      type="number"
      step={step}
      min={0}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => onChange(Number.parseFloat(e.target.value) || 0)}
      className={`${className} bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-sm`}
    />
  );
}

const card = 'rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3';
const input = 'w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm';

/** One clip: watch the Short, edit hook / voiceover / texts / trim, re-render, and copy the upload details. */
export default function ClipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [clip, setClip] = useState<ClipProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadDescription, setUploadDescription] = useState('');
  const [draft, setDraft] = useState<ClipPlan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [style, setStyle] = useState<ClipPlan['voiceStyle']>('hype');
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  type Loaded = { clip: ClipProject; busy: boolean; uploadDescription: string } | null;
  const fetchClip = useCallback(async (): Promise<Loaded> => {
    const res = await fetch(`/api/clips/${id}`, { cache: 'no-store' });
    return res.status === 404 ? null : ((await res.json()) as Loaded);
  }, [id]);

  const apply = useCallback((data: Loaded) => {
    if (!data) return setNotFound(true);
    setClip(data.clip);
    setBusy(data.busy);
    setUploadDescription(data.uploadDescription);
    // Don't overwrite edits in progress
    if (!dirtyRef.current && data.clip.plan) {
      setDraft(data.clip.plan);
      setStyle(data.clip.plan.voiceStyle);
    }
  }, []);

  const load = useCallback(() => fetchClip().then(apply).catch(() => {}), [fetchClip, apply]);

  useEffect(() => {
    let cancelled = false;
    fetchClip()
      .then((data) => {
        if (!cancelled) apply(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchClip, apply]);

  const working = busy || (clip !== null && !terminal(clip.status));
  useEffect(() => {
    if (!working) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [working, load]);

  const edit = (change: Partial<ClipPlan>) => {
    setDraft((d) => (d ? { ...d, ...change } : d));
    setDirty(true);
  };

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    setError(null);
    const res = await fetch(`/api/clips/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: draft }) });
    const data = (await res.json()) as { clip?: ClipProject; uploadDescription?: string; error?: string };
    if (!res.ok || !data.clip) {
      setError(data.error || 'Could not save');
      return false;
    }
    setClip(data.clip);
    setUploadDescription(data.uploadDescription ?? '');
    setDraft(data.clip.plan ?? null);
    setDirty(false);
    return true;
  };

  const run = async (from: 'render' | 'script' | 'all') => {
    if (from === 'render' && dirty && !(await save())) return;
    if (from !== 'render' && dirty && !confirm('This replaces your unsaved edits. Continue?')) return;
    setError(null);
    const res = await fetch(`/api/clips/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, voiceStyle: style }) });
    if (!res.ok) setError(((await res.json()) as { error?: string }).error || 'Could not start');
    setDirty(false);
    await load();
  };

  const remove = async () => {
    if (!confirm('Delete this clip and its files?')) return;
    const res = await fetch(`/api/clips/${id}`, { method: 'DELETE' });
    if (res.ok) router.push('/clips');
    else setError(((await res.json()) as { error?: string }).error || 'Could not delete');
  };

  if (notFound) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
        <p>Clip not found. <Link href="/clips" className="underline">Back to clips</Link></p>
      </div>
    );
  }
  if (!clip) return <div className="min-h-screen bg-zinc-950 text-zinc-400 p-8">Loading…</div>;

  const a = clip.analysis;
  const stepIndex = STEPS.indexOf(clip.status);
  const setLine = (i: number, change: Partial<VoiceLine>) => edit({ voiceLines: draft!.voiceLines.map((l, k) => (k === i ? { ...l, ...change } : l)) });
  const setOverlay = (i: number, change: Partial<TextOverlay>) => edit({ overlays: draft!.overlays.map((o, k) => (k === i ? { ...o, ...change } : o)) });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <Link href="/clips" className="text-sm text-zinc-500 hover:text-zinc-300">← Clips</Link>
            <h1 className="text-xl font-bold mt-1 truncate">{clip.plan?.titles[0] || clip.source?.title || 'New clip'}</h1>
            <a href={clip.source?.pageUrl || clip.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-zinc-500 hover:text-zinc-300 break-all">
              {clip.source ? `${clip.source.platform} · ${clip.creator || clip.source.uploaderHandle || clip.source.uploader}` : clip.sourceUrl}
            </a>
          </div>
          <button onClick={remove} disabled={working} className="text-xs text-zinc-500 hover:text-red-400 disabled:opacity-40">Delete clip</button>
        </div>

        {working && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            <span className="animate-pulse">●</span> {clip.step}
            {stepIndex >= 0 && <span className="text-amber-200/60"> · step {stepIndex + 1} of {STEPS.length}</span>}
            {clip.status === 'analyzing' && <span className="text-amber-200/60"> (the first run downloads the Whisper model, which takes a minute)</span>}
          </div>
        )}
        {clip.status === 'failed' && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200 flex items-center justify-between gap-3 flex-wrap">
            <span>{clip.error}</span>
            <button onClick={() => run(clip.analysis ? 'render' : 'all')} className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold">Try again</button>
          </div>
        )}
        {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}
        {clip.warnings.length > 0 && !working && (
          <ul className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-amber-300/90 space-y-1 list-disc pl-6">
            {clip.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}

        <div className="grid lg:grid-cols-[360px_1fr] gap-5 items-start">
          {/* Preview and downloads */}
          <div className="space-y-3 lg:sticky lg:top-4">
            {clip.output ? (
              <video key={clip.output.renderedAt} src={`/api/clips/${id}/file?name=video&v=${encodeURIComponent(clip.output.renderedAt)}`} controls playsInline className="w-full aspect-[9/16] rounded-2xl bg-black border border-zinc-800" />
            ) : (
              <div className="w-full aspect-[9/16] rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-sm text-zinc-500">{working ? 'Making your Short…' : 'Not rendered yet'}</div>
            )}
            {clip.output && (
              <div className="grid grid-cols-1 gap-2">
                <a href={`/api/clips/${id}/file?name=package`} className="text-center px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-sm">⬇ Download export package (.zip)</a>
                <div className="grid grid-cols-2 gap-2">
                  <a href={`/api/clips/${id}/file?name=video&download=1`} className="text-center px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm">Short (.mp4)</a>
                  <a href={`/api/clips/${id}/file?name=thumbnail&download=1`} className="text-center px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm">Thumbnail</a>
                </div>
                <p className="text-xs text-zinc-500 text-center">{clip.output.durationSec.toFixed(1)}s · 1080×1920</p>
              </div>
            )}
          </div>

          {/* Editor */}
          {draft && a ? (
            <div className="space-y-4">
              <div className={card}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <h2 className="font-semibold">Edit</h2>
                  <div className="flex gap-2 flex-wrap">
                    <button onClick={() => run('render')} disabled={working} className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white font-semibold text-sm">
                      {dirty ? 'Save & re-render' : 'Re-render'}
                    </button>
                    {dirty && <button onClick={save} disabled={working} className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-sm">Save only</button>}
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  <Toggle label="Captions" checked={draft.captions} onChange={(v) => edit({ captions: v })} />
                  <Toggle label="Mask swear words in captions" checked={draft.cleanCaptions} onChange={(v) => edit({ cleanCaptions: v })} />
                  <Toggle label="Hook text" checked={draft.showHook} onChange={(v) => edit({ showHook: v })} />
                  <Toggle label="Voiceover" checked={draft.voiceover} onChange={(v) => edit({ voiceover: v })} />
                  <Toggle label="Zoom on the big moment" checked={draft.zoomOnPeak} onChange={(v) => edit({ zoomOnPeak: v })} />
                  <Toggle label="Impact sound on the big moment" checked={draft.sfxOnPeak} onChange={(v) => edit({ sfxOnPeak: v })} />
                  {a.musicSections.length > 0 && (
                    <Toggle label={`Mute possible music (${a.musicSections.map((m) => `${m.start.toFixed(0)}–${m.end.toFixed(0)}s`).join(', ')})`} checked={draft.muteMusic} onChange={(v) => edit({ muteMusic: v })} />
                  )}
                </div>
                <div className="flex flex-wrap gap-4 text-sm items-center">
                  <label className="flex items-center gap-2">
                    Layout
                    <select value={draft.layout} onChange={(e) => edit({ layout: e.target.value as ClipPlan['layout'] })} className="bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1">
                      <option value="crop">Full screen (centre crop)</option>
                      <option value="fit">Whole picture + blurred fill</option>
                      <option value="original">Original (vertical clip)</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2">
                    Voice
                    <input value={draft.voice} onChange={(e) => edit({ voice: e.target.value })} placeholder="default" className="w-28 bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1" />
                  </label>
                </div>
              </div>

              <div className={card}>
                <h2 className="font-semibold">Timing</h2>
                <div className="flex flex-wrap gap-4 text-sm items-center">
                  <label className="flex items-center gap-2">Start <Num value={draft.trimStart} onChange={(v) => edit({ trimStart: v })} />s</label>
                  <label className="flex items-center gap-2">End <Num value={draft.trimEnd} onChange={(v) => edit({ trimEnd: v })} />s</label>
                  <label className="flex items-center gap-2">Big moment <Num value={draft.peakSec ?? 0} onChange={(v) => edit({ peakSec: v })} />s</label>
                  <span className="text-xs text-zinc-500">Clip is {a.durationSec.toFixed(1)}s · Short is {(draft.trimEnd - draft.trimStart).toFixed(1)}s{draft.trimEnd - draft.trimStart > 60 ? ' (over 60s)' : ''}</span>
                </div>
                <p className="text-xs text-zinc-500">All times are seconds into the original clip.{a.peaks.length ? ` Loud moments: ${a.peaks.map((p) => `${p.at.toFixed(1)}s`).join(', ')}.` : ''}</p>
              </div>

              <div className={card}>
                <h2 className="font-semibold">Hook</h2>
                <div className="flex gap-2 items-center">
                  <input value={draft.hook} onChange={(e) => edit({ hook: e.target.value })} className={input} maxLength={120} />
                  <Num value={draft.hookSec} onChange={(v) => edit({ hookSec: v })} />
                  <span className="text-xs text-zinc-500">s</span>
                </div>
                <p className="text-xs text-zinc-500">Emoji are left out of on-screen text (the caption font can&apos;t draw them).</p>
              </div>

              <div className={card}>
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">Voiceover lines</h2>
                  <button onClick={() => edit({ voiceLines: [...draft.voiceLines, { at: draft.trimStart, text: '', slot: 'other' }] })} className="text-xs px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700">+ Add line</button>
                </div>
                {draft.voiceLines.length === 0 && <p className="text-sm text-zinc-500">No voiceover lines.</p>}
                {draft.voiceLines.map((l, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <Num value={l.at} onChange={(v) => setLine(i, { at: v })} />
                    <input value={l.text} onChange={(e) => setLine(i, { text: e.target.value })} className={input} />
                    <span className={`text-xs shrink-0 ${l.audioFile ? 'text-emerald-400' : 'text-zinc-500'}`} title={l.audioFile ? `${l.durationSec?.toFixed(1)}s` : 'Voiced on the next render'}>{l.audioFile ? '● voiced' : '○'}</span>
                    <button onClick={() => edit({ voiceLines: draft.voiceLines.filter((_, k) => k !== i) })} className="text-zinc-500 hover:text-red-400 text-sm">✕</button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-zinc-800 text-sm">
                  <span className="text-zinc-400">New script in style</span>
                  <select value={style} onChange={(e) => setStyle(e.target.value as ClipPlan['voiceStyle'])} className="bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1">
                    <option value="hype">Hype / meme</option>
                    <option value="narrator">Narrator</option>
                    <option value="info">Info / tips</option>
                  </select>
                  <button onClick={() => run('script')} disabled={working} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40">↻ Regenerate</button>
                  <span className="text-xs text-zinc-500">Rewrites the hook, texts, voiceover and titles.</span>
                </div>
              </div>

              <div className={card}>
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">On-screen texts</h2>
                  <button onClick={() => edit({ overlays: [...draft.overlays, { at: draft.trimStart + draft.hookSec + 0.5, until: draft.trimStart + draft.hookSec + 2.5, text: '' }] })} className="text-xs px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700">+ Add text</button>
                </div>
                {draft.overlays.length === 0 && <p className="text-sm text-zinc-500">None.</p>}
                {draft.overlays.map((o, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <Num value={o.at} onChange={(v) => setOverlay(i, { at: v })} />
                    <span className="text-zinc-500 text-xs">to</span>
                    <Num value={o.until} onChange={(v) => setOverlay(i, { until: v })} />
                    <input value={o.text} onChange={(e) => setOverlay(i, { text: e.target.value })} className={input} maxLength={80} />
                    <button onClick={() => edit({ overlays: draft.overlays.filter((_, k) => k !== i) })} className="text-zinc-500 hover:text-red-400 text-sm">✕</button>
                  </div>
                ))}
              </div>

              <div className={card}>
                <h2 className="font-semibold">Upload details</h2>
                <div className="space-y-2">
                  <p className="text-xs text-zinc-400">Titles</p>
                  {draft.titles.map((t, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input value={t} onChange={(e) => edit({ titles: draft.titles.map((x, k) => (k === i ? e.target.value : x)) })} className={input} maxLength={100} />
                      <span className={`text-xs w-8 text-right ${t.length > 70 ? 'text-amber-400' : 'text-zinc-500'}`}>{t.length}</span>
                      <button onClick={() => copy(t)} className="text-xs px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700">Copy</button>
                    </div>
                  ))}
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-zinc-400">Description (the credit and hashtags are added below it)</p>
                  <textarea value={draft.description} onChange={(e) => edit({ description: e.target.value })} rows={3} className={input} />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-zinc-400">Full description to paste{dirty ? ' (save to update)' : ''}</p>
                    <button onClick={() => copy(uploadDescription)} className="text-xs px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700">Copy</button>
                  </div>
                  <pre className="whitespace-pre-wrap text-xs bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-zinc-300">{uploadDescription}</pre>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-zinc-400">Tags (comma separated)</p>
                    <button onClick={() => copy(draft.tags.join(', '))} className="text-xs px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700">Copy</button>
                  </div>
                  <input value={draft.tags.join(', ')} onChange={(e) => edit({ tags: e.target.value.split(',').map((t) => t.trimStart()) })} className={input} />
                </div>
              </div>

              <div className={card}>
                <h2 className="font-semibold">In-game dialogue</h2>
                <p className="text-sm text-zinc-300">{a.transcript || <span className="text-zinc-500">No dialogue heard.</span>}</p>
                <div className="pt-2 border-t border-zinc-800 flex items-center gap-3">
                  <button onClick={() => run('all')} disabled={working} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40">Start over from the download</button>
                </div>
              </div>
            </div>
          ) : (
            <div className={`${card} text-sm text-zinc-500`}>The editor appears once the clip has been analysed and scripted.</div>
          )}
        </div>
      </div>
    </div>
  );
}
