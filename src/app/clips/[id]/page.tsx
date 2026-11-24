'use client';

import React, { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PageContainer, EmptyState } from '@/components/ui/page';
import { ButtonLink } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { useRouter } from 'next/navigation';
import type { ClipEffect, ClipPlan, ClipProject, CutIn, Ending, FramePoint, TextOverlay, VoiceLine } from '@/pipeline/clipping/types';

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
const small = 'text-xs px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700';

const CUT_IN_LABEL: Record<CutIn['kind'], string> = { meme: '😂 Meme', freeze: '⏸ Freeze', replay: '🔁 Slow-mo replay', ramp: '🐢 Speed ramp', skull: '💀 Skull hit', skip: '✂️ Cut out', teaser: '⏪ Cold open' };
const EFFECT_LABEL: Record<ClipEffect['kind'], string> = { flash: 'Red flash', shake: 'Camera shake + thud', emoji: 'Emoji pop-up', sound: 'Meme sound', comic: 'Comic-dot flash' };
const ENDING_TEXT: Record<Ending['style'], string> = { none: '', tbc: 'TO BE CONTINUED', credits: 'Directed by\nJASON', stamp: 'SKILL ISSUE', skull: '', recap: '' };
const ENDING_SOUND: Record<Ending['style'], string> = { none: '', tbc: 'to be continued', credits: 'directed by', stamp: 'vine boom', skull: 'kai cenat boom', recap: 'dark impact' };
const ENDING_SEC: Record<Ending['style'], number> = { none: 0, tbc: 2.6, credits: 3, stamp: 2, skull: 1.6, recap: 2.4 };

/** A still of the clip at a time; click to set a point (as fractions of the picture). */
function FramePicker({ id, t, value, onPick, onClear, label }: { id: string; t: number; value?: FramePoint; onPick: (p: FramePoint) => void; onClear: () => void; label: string }) {
  const [open, setOpen] = useState(false);
  const shown = Math.round(t * 10) / 10;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <button onClick={() => setOpen((o) => !o)} className={small}>{open ? 'Hide frame' : value ? `📍 ${label} set` : `📍 ${label}`}</button>
        {value && <button onClick={onClear} className="text-zinc-500 hover:text-red-400">clear</button>}
      </div>
      {open && (
        <div className="relative w-full max-w-md cursor-crosshair select-none" onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onPick({ x: Math.round(((e.clientX - r.left) / r.width) * 100) / 100, y: Math.round(((e.clientY - r.top) / r.height) * 100) / 100 });
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/clips/${id}/file?name=frame&t=${shown}`} alt={`Frame at ${shown}s`} className="w-full rounded-lg border border-zinc-800" draggable={false} />
          {value && <span className="absolute w-8 h-8 -ml-4 -mt-4 rounded-full border-4 border-red-500 pointer-events-none" style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%` }} />}
          <p className="text-xs text-zinc-500 mt-1">Frame at {shown}s: click the spot.</p>
        </div>
      )}
    </div>
  );
}

/** The reaction edit's parts: header box, cut-ins, hits/emoji/sounds, zoom aim, ending and loop. */
function ReactionEditor({ id, draft, edit }: { id: string; draft: ClipPlan; edit: (change: Partial<ClipPlan>) => void }) {
  const header = draft.header ?? { text: draft.hook, highlight: [] };
  const cutIns = draft.cutIns ?? [];
  const effects = draft.effects ?? [];
  const ending = draft.ending;
  const peak = draft.peakSec ?? draft.trimStart;
  const setCut = (i: number, change: Partial<CutIn>) => edit({ cutIns: cutIns.map((c, k) => (k === i ? { ...c, ...change } : c)) });
  const setFx = (i: number, change: Partial<ClipEffect>) => edit({ effects: effects.map((e, k) => (k === i ? { ...e, ...change } : e)) });
  const add = (c: CutIn) => edit({ cutIns: [...cutIns, c].sort((a, b) => a.at - b.at) });
  const field = 'bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-sm';
  // Names in the emoji and sound libraries, offered while typing
  const [library, setLibrary] = useState<{ emojis: string[]; sounds: string[] }>({ emojis: [], sounds: [] });
  useEffect(() => {
    fetch('/api/clips/library')
      .then((r) => r.json())
      .then((d: { emojis?: string[]; sounds?: string[] }) => setLibrary({ emojis: d.emojis ?? [], sounds: d.sounds ?? [] }))
      .catch(() => {});
  }, []);
  return (
    <div className={card}>
      <h2 className="font-semibold">Reaction edit</h2>
      <div className="space-y-1">
        <p className="text-xs text-zinc-400">Header box (on screen the whole time; emoji show in colour)</p>
        <input value={header.text} onChange={(e) => edit({ header: { ...header, text: e.target.value } })} className={input} maxLength={120} />
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Red words
          <input value={header.highlight.join(', ')} onChange={(e) => edit({ header: { ...header, highlight: e.target.value.split(',').map((w) => w.trimStart()).filter(Boolean) } })} placeholder="ZERO, chill" className={`flex-1 ${field}`} />
        </label>
      </div>

      <div className="space-y-2 pt-2 border-t border-zinc-800">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs text-zinc-400">Cut-ins (the clip pauses, this plays, the clip carries on)</p>
          <div className="flex gap-1.5 flex-wrap">
            <button onClick={() => add({ kind: 'meme', at: Math.min(draft.trimEnd, peak + 0.4), durationSec: 1.4, query: '', pick: 0 })} className={small}>+ Meme</button>
            <button onClick={() => add({ kind: 'freeze', at: Math.max(draft.trimStart + 0.6, peak - 1.5), durationSec: 1.6 })} className={small}>+ Freeze</button>
            <button onClick={() => add({ kind: 'ramp', at: peak, durationSec: 0.8, replaySec: 0.8 })} className={small}>+ Speed ramp</button>
            <button onClick={() => add({ kind: 'replay', at: Math.min(draft.trimEnd, peak + 1), durationSec: 2.4, replaySec: 1.2 })} className={small}>+ Replay</button>
            <button onClick={() => add({ kind: 'skull', at: Math.min(draft.trimEnd, peak + 0.3), durationSec: 0.9 })} className={small}>+ Skull hit</button>
            <button onClick={() => add({ kind: 'teaser', at: Math.min(draft.trimEnd, peak + 0.5), durationSec: 2.25, replaySec: 1.8 })} className={small} title="Show the big moment first, then rewind to the start">+ Cold open</button>
            <button onClick={() => add({ kind: 'skip', at: draft.trimStart + 5, durationSec: 0, skipSec: 5 })} className={small} title="Cut a slow stretch out of the middle">+ Cut out</button>
          </div>
        </div>
        {cutIns.length === 0 && <p className="text-sm text-zinc-500">None.</p>}
        {cutIns.map((c, i) => (
          <div key={i} className="rounded-lg border border-zinc-800 p-2 space-y-1.5">
            <div className="flex gap-2 items-center flex-wrap">
              <span className="text-sm w-36 shrink-0">{CUT_IN_LABEL[c.kind]}</span>
              <span className="text-xs text-zinc-500">{c.kind === 'ramp' ? 'into' : 'at'}</span>
              <Num value={c.at} onChange={(v) => setCut(i, { at: v })} />
              {c.kind === 'skip' && (
                <>
                  <span className="text-xs text-zinc-500">cuts the next</span>
                  <Num value={c.skipSec ?? 5} onChange={(v) => setCut(i, { skipSec: v })} className="w-16" />
                  <span className="text-xs text-zinc-500">s (to {(c.at + (c.skipSec ?? 0)).toFixed(1)}s)</span>
                </>
              )}
              {c.kind === 'skull' && (
                <input value={c.emoji ?? ''} onChange={(e) => setCut(i, { emoji: e.target.value })} placeholder="💀 or skull exploding" list="emoji-names" className={`w-44 ${field}`} />
              )}
              {(c.kind === 'meme' || c.kind === 'freeze') && (
                <>
                  <span className="text-xs text-zinc-500">for</span>
                  <Num value={c.durationSec} onChange={(v) => setCut(i, { durationSec: v })} className="w-16" />
                  <span className="text-xs text-zinc-500">s{c.kind === 'freeze' ? ' (longer if a voice line is on it)' : ''}</span>
                </>
              )}
              {c.kind === 'teaser' && (
                <>
                  <span className="text-xs text-zinc-500">opens on the</span>
                  <Num value={c.replaySec ?? 1.8} onChange={(v) => setCut(i, { replaySec: v, durationSec: v * 1.25 })} className="w-16" />
                  <span className="text-xs text-zinc-500">s up to here, then rewinds</span>
                </>
              )}
              {(c.kind === 'replay' || c.kind === 'ramp') && (
                <>
                  <span className="text-xs text-zinc-500">{c.kind === 'replay' ? 'replays the last' : 'slows the last'}</span>
                  <Num value={c.replaySec ?? (c.kind === 'replay' ? 1.2 : 0.8)} onChange={(v) => setCut(i, { replaySec: v, durationSec: c.kind === 'replay' ? Math.max(0.6, v * 2) : v })} className="w-16" />
                  <span className="text-xs text-zinc-500">s to half speed</span>
                </>
              )}
              <button onClick={() => edit({ cutIns: cutIns.filter((_, k) => k !== i) })} className="ml-auto text-zinc-500 hover:text-red-400 text-sm">✕</button>
            </div>
            {c.kind === 'meme' && (
              <div className="flex gap-2 items-center flex-wrap">
                <input value={c.query ?? ''} onChange={(e) => setCut(i, { query: e.target.value, pick: 0 })} placeholder="its working, shocked guy, awkward look…" className={`flex-1 min-w-40 ${field}`} />
                <button onClick={() => setCut(i, { pick: (c.pick ?? 0) + 1 })} className={small} title="Use the next search result on the next render">Try another</button>
                <span className="text-xs text-zinc-500 truncate max-w-56" title={c.meme?.origin}>
                  {c.meme ? `${c.meme.source}: ${c.meme.title}${c.meme.key === `${(c.query ?? '').trim().toLowerCase()}|${c.pick ?? 0}` ? '' : ' (changes on re-render)'}` : 'found on the next render'}
                </span>
              </div>
            )}
            {c.kind === 'freeze' && (
              <FramePicker id={id} t={c.at} value={c.focus} label="Circle a spot" onPick={(focus) => setCut(i, { focus })} onClear={() => setCut(i, { focus: undefined })} />
            )}
          </div>
        ))}
        <p className="text-xs text-zinc-500">Memes come from storage/memes first, then KLIPY clips (with sound) and GIFs, then GIPHY. A freeze speaks the voice line placed at the same time, with a record scratch. A speed ramp slows the moments just before the time you give.</p>
      </div>

      <div className="space-y-2 pt-2 border-t border-zinc-800">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs text-zinc-400">Hits, emoji and meme sounds</p>
          <div className="flex gap-1.5">
            <button onClick={() => edit({ effects: [...effects, { at: peak, kind: 'flash' }] })} className={small}>+ Hit</button>
            <button onClick={() => edit({ effects: [...effects, { at: peak + 0.5, kind: 'emoji', emoji: '💀' }] })} className={small}>+ Emoji</button>
            <button onClick={() => edit({ effects: [...effects, { at: peak, kind: 'comic' }] })} className={small}>+ Comic</button>
            <button onClick={() => edit({ effects: [...effects, { at: peak, kind: 'sound', query: 'vine boom' }] })} className={small}>+ Sound</button>
          </div>
        </div>
        {effects.map((e, i) => (
          <div key={i} className="flex gap-2 items-center flex-wrap">
            <Num value={e.at} onChange={(v) => setFx(i, { at: v })} />
            <select value={e.kind} onChange={(ev) => setFx(i, { kind: ev.target.value as ClipEffect['kind'] })} className={field}>
              {(Object.keys(EFFECT_LABEL) as ClipEffect['kind'][]).map((k) => <option key={k} value={k}>{EFFECT_LABEL[k]}</option>)}
            </select>
            {e.kind === 'emoji' && <input value={e.emoji ?? ''} onChange={(ev) => setFx(i, { emoji: ev.target.value })} className={`w-52 ${field}`} placeholder="💀 or skull exploding" list="emoji-names" />}
            {e.kind === 'sound' && (
              <>
                <input value={e.query ?? ''} onChange={(ev) => setFx(i, { query: ev.target.value })} className={`flex-1 min-w-32 ${field}`} placeholder="vine boom, bruh, metal pipe…" list="sound-names" />
                <span className="text-xs text-zinc-500 truncate max-w-40">{e.sound ? `${e.sound.source}: ${e.sound.title}` : 'found on the next render'}</span>
              </>
            )}
            <button onClick={() => edit({ effects: effects.filter((_, k) => k !== i) })} className="text-zinc-500 hover:text-red-400 text-sm">✕</button>
          </div>
        ))}
        <p className="text-xs text-zinc-500">Emoji: type one (💀) or a picture&apos;s name from storage/emojis ({library.emojis.length} there). Sounds come from storage/sounds ({library.sounds.length} names); built in: boom, ding, riser, record scratch.</p>
        <datalist id="emoji-names">{library.emojis.map((n) => <option key={n} value={n.replace(/-/g, ' ')} />)}</datalist>
        <datalist id="sound-names">{library.sounds.map((n) => <option key={n} value={n} />)}</datalist>
      </div>

      <div className="grid sm:grid-cols-3 gap-2 pt-2 border-t border-zinc-800">
        <Toggle label="Whip blur on cuts" checked={draft.whipBlur !== false} onChange={(v) => edit({ whipBlur: v })} hint="A quick motion blur into and out of every cut-in and the ending" />
        <Toggle label="Punchy colour" checked={!!draft.grade} onChange={(v) => edit({ grade: v })} hint="More contrast and saturation, sharper, dark edges" />
        <Toggle label="Glowing captions" checked={draft.glowCaptions !== false} onChange={(v) => edit({ glowCaptions: v })} hint="The spoken word glows, a different colour each line" />
      </div>

      <div className="space-y-2 pt-2 border-t border-zinc-800">
        <p className="text-xs text-zinc-400">Zoom on the big moment</p>
        <FramePicker id={id} t={peak} value={draft.zoomFocus} label="Aim the zoom" onPick={(zoomFocus) => edit({ zoomFocus })} onClear={() => edit({ zoomFocus: undefined })} />
      </div>

      <div className="space-y-2 pt-2 border-t border-zinc-800">
        <div className="flex items-center gap-3 flex-wrap text-sm">
          <label className="flex items-center gap-2">
            Ending
            <select
              value={ending?.style ?? 'none'}
              onChange={(e) => {
                const style = e.target.value as Ending['style'];
                edit({ ending: style === 'none' ? undefined : { style, text: ENDING_TEXT[style], query: ENDING_SOUND[style], durationSec: ENDING_SEC[style], ...(style === 'skull' ? { emoji: '💀' } : {}) } });
              }}
              className={field}
            >
              <option value="none">None</option>
              <option value="tbc">To be continued (sepia + arrow)</option>
              <option value="credits">Credits on black</option>
              <option value="stamp">Fail stamp (black &amp; white)</option>
              <option value="skull">Skull (grey freeze + big skull)</option>
              <option value="recap">Rapid recap (best moments, quick cuts)</option>
            </select>
          </label>
          {!ending && <Toggle label="Loop back to the start" checked={!!draft.loop} onChange={(v) => edit({ loop: v })} hint="No fade at the end: the last moment blends into the first frame" />}
        </div>
        {ending && (
          <div className="grid sm:grid-cols-2 gap-2">
            {ending.style === 'recap' ? (
              <div className="space-y-1">
                <input value={ending.emoji ?? ''} onChange={(e) => edit({ ending: { ...ending, emoji: e.target.value } })} className={input} placeholder="landing emoji: skull exploding" list="emoji-names" />
                <p className="text-xs text-zinc-400">Replays up to four of the edit&apos;s highlights (memes, the circled freeze, skulls, emoji) in black and white, then lands on the big moment in colour.</p>
              </div>
            ) : ending.style === 'skull' ? (
              <input value={ending.emoji ?? ''} onChange={(e) => edit({ ending: { ...ending, emoji: e.target.value } })} className={input} placeholder="💀 or skull exploding" list="emoji-names" />
            ) : ending.style === 'credits' ? (
              <textarea value={ending.text} onChange={(e) => edit({ ending: { ...ending, text: e.target.value } })} rows={2} className={input} />
            ) : (
              <input value={ending.text} onChange={(e) => edit({ ending: { ...ending, text: e.target.value } })} className={input} maxLength={60} />
            )}
            <div className="space-y-1">
              <input value={ending.query ?? ''} onChange={(e) => edit({ ending: { ...ending, query: e.target.value } })} className={input} placeholder="sound" list="sound-names" />
              <p className="text-xs text-zinc-500">{ending.sound ? `${ending.sound.source}: ${ending.sound.title}` : 'Found on the next render (a built-in sound if it isn’t in storage/sounds)'}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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
      <PageContainer>
        <EmptyState title="Clip not found" action={<ButtonLink href="/clips" icon="chevronLeft">Back to clips</ButtonLink>} />
      </PageContainer>
    );
  }
  if (!clip)
    return (
      <PageContainer>
        <EmptyState loading title="Loading the clip…" />
      </PageContainer>
    );

  const a = clip.analysis;
  const stepIndex = STEPS.indexOf(clip.status);
  const setLine = (i: number, change: Partial<VoiceLine>) => edit({ voiceLines: draft!.voiceLines.map((l, k) => (k === i ? { ...l, ...change } : l)) });
  const setOverlay = (i: number, change: Partial<TextOverlay>) => edit({ overlays: draft!.overlays.map((o, k) => (k === i ? { ...o, ...change } : o)) });

  return (
    <PageContainer>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <Link href="/clips" className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-200"><Icon name="chevronLeft" size={14} />Clips</Link>
            <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-zinc-50 truncate">{clip.plan?.titles[0] || clip.source?.title || 'New clip'}</h1>
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
                    Style
                    <select value={draft.editStyle ?? 'classic'} onChange={(e) => edit({ editStyle: e.target.value as ClipPlan['editStyle'] })} className="bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1">
                      <option value="reaction">Reaction edit (header, memes, hits)</option>
                      <option value="classic">Classic (hook + captions)</option>
                    </select>
                  </label>
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

              {draft.editStyle === 'reaction' && <ReactionEditor id={id} draft={draft} edit={edit} />}

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
    </PageContainer>
  );
}
