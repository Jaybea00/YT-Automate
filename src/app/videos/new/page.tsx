'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { FormatDef } from '@/lib/styles/formats';
import type { NicheDef } from '@/lib/styles/niches';
import {
  composePack,
  DEFAULT_SETUP,
  normalizeSetup,
  setupForVideo,
  type Audience,
  type LookId,
  type StyleLibrary,
  type StyleSetup,
  type WriterVoice,
} from '@/lib/styles/compose';
import { narrationPaceFactor } from '@/lib/styles/packs';
import { briefForAngle, type VideoAngle } from '@/lib/script/angle-brief';
import { describeEstimate, estimateCreation, presetFor, RUNTIME_PRESETS, runtimeNote } from '@/lib/script/creation-estimate';

type Tab = 'ai' | 'raw' | 'srt';

interface StylesResponse {
  formats: FormatDef[];
  niches: NicheDef[];
  looks: Array<{ id: LookId; name: string; description: string }>;
  audiences: Array<{ id: Audience; name: string; description: string }>;
  voices: WriterVoice[];
}

interface RecentVideo {
  id: string;
  title?: string | null;
  topic?: string | null;
  style?: string | null;
  target_minutes?: number | null;
  script_json?: unknown;
}

/** The last setup and length used, remembered in this browser only. */
const REMEMBER_KEY = 'yt.newVideo.last';
const MAX_BATCH = 10;

function readRemembered(): { setup?: Partial<StyleSetup>; minutes?: number } | null {
  try {
    const raw = window.localStorage.getItem(REMEMBER_KEY);
    return raw ? (JSON.parse(raw) as { setup?: Partial<StyleSetup>; minutes?: number }) : null;
  } catch {
    return null;
  }
}

function remember(setup: StyleSetup, minutes: number) {
  try {
    window.localStorage.setItem(REMEMBER_KEY, JSON.stringify({ setup, minutes }));
  } catch {
    // private window or storage blocked: nothing to remember
  }
}

const card = (selected: boolean) =>
  `p-3 rounded-xl border cursor-pointer transition text-left w-full ${
    selected ? 'border-indigo-500 bg-indigo-500/10' : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700'
  }`;

export default function NewVideoPage() {
  const router = useRouter();

  const [tab, setTab] = useState<Tab>('ai');
  const [styles, setStyles] = useState<StylesResponse | null>(null);
  const [stylesError, setStylesError] = useState<string | null>(null);
  const [setup, setSetup] = useState<Required<StyleSetup>>(DEFAULT_SETUP);
  const [showMore, setShowMore] = useState(false);

  // AI tab
  const [topic, setTopic] = useState('');
  const [brief, setBrief] = useState('');
  const [minutes, setMinutes] = useState<number>(10);
  const [customMinutes, setCustomMinutes] = useState(false);
  /** Once you pick a length, a new format no longer changes it. */
  const [runtimeTouched, setRuntimeTouched] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [batchTopics, setBatchTopics] = useState('');

  // Angles
  const [angles, setAngles] = useState<VideoAngle[]>([]);
  const [anglesLoading, setAnglesLoading] = useState(false);
  const [anglesError, setAnglesError] = useState<string | null>(null);
  const [chosenAngle, setChosenAngle] = useState<string | null>(null);
  const angleBriefRef = useRef<string | null>(null);

  // Paste and SRT tabs
  const [rawText, setRawText] = useState('');
  const [rawMode, setRawMode] = useState<'raw_paragraphs' | 'raw_ai'>('raw_paragraphs');
  const [srtText, setSrtText] = useState('');
  const [smartMerge, setSmartMerge] = useState(true);

  const [recent, setRecent] = useState<RecentVideo[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const library: StyleLibrary = useMemo(
    () => ({
      formats: (styles?.formats ?? []).filter((f) => f.custom),
      niches: (styles?.niches ?? []).filter((n) => n.custom),
      voices: styles?.voices ?? [],
    }),
    [styles],
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/styles')
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load the formats and niches.');
        return data as StylesResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setStyles(data);
        const lib = { formats: data.formats.filter((f) => f.custom), niches: data.niches.filter((n) => n.custom), voices: data.voices };
        const last = readRemembered();
        if (last?.setup) setSetup(normalizeSetup(last.setup, lib));
        if (last?.minutes && last.minutes > 0 && last.minutes <= 60) {
          setMinutes(last.minutes);
          setCustomMinutes(!presetFor(last.minutes));
          setRuntimeTouched(true);
        }
      })
      .catch((err) => !cancelled && setStylesError(err instanceof Error ? err.message : 'Could not load the formats and niches.'));
    fetch('/api/videos')
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: RecentVideo[]) => !cancelled && setRecent(Array.isArray(rows) ? rows.slice(0, 15) : []))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const composed = useMemo(() => (styles ? composePack(setup, library) : null), [styles, setup, library]);
  const format = styles?.formats.find((f) => f.id === setup.format);
  const niche = styles?.niches.find((n) => n.id === setup.niche);

  // The niche's suggested formats first, then the rest in their usual order
  const orderedFormats = useMemo(() => {
    const all = styles?.formats ?? [];
    const suggested = niche?.suggestedFormats ?? [];
    return [...all].sort((a, b) => {
      const ia = suggested.indexOf(a.id);
      const ib = suggested.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [styles, niche]);

  const batchList = useMemo(
    () => [...new Set(batchTopics.split(/\r?\n/).map((t) => t.trim()).filter(Boolean))],
    [batchTopics],
  );

  const estimate = useMemo(() => {
    if (tab === 'srt' || (tab === 'raw' && rawMode === 'raw_paragraphs')) return null;
    return estimateCreation({
      mode: tab === 'raw' ? 'raw_ai' : 'ai',
      minutes: tab === 'raw' ? 3 : minutes,
      withBrief: tab === 'ai' && Boolean(brief.trim()),
      paceFactor: composed ? narrationPaceFactor(composed.legacyStyle, composed.pack) : 1,
      count: tab === 'ai' && batchMode ? Math.max(1, batchList.length) : 1,
    });
  }, [tab, rawMode, minutes, brief, composed, batchMode, batchList.length]);

  function updateSetup(patch: Partial<StyleSetup>) {
    setSetup(normalizeSetup({ ...setup, ...patch }, library));
    // A new format brings its usual length, unless you've chosen one
    if (patch.format && !runtimeTouched) {
      const f = styles?.formats.find((x) => x.id === patch.format);
      if (f) {
        setMinutes(f.suggestedMinutes);
        setCustomMinutes(!presetFor(f.suggestedMinutes));
      }
    }
  }

  function chooseMinutes(value: number, custom = false) {
    setRuntimeTouched(true);
    setCustomMinutes(custom);
    setMinutes(value);
  }

  function startFrom(videoId: string) {
    const video = recent.find((v) => v.id === videoId);
    if (!video) return;
    setSetup(normalizeSetup(setupForVideo(video), library));
    const m = Number(video.target_minutes);
    if (m > 0 && m <= 60) chooseMinutes(m, !presetFor(m));
  }

  async function findAngles() {
    if (!topic.trim()) {
      setAnglesError('Type a rough topic first.');
      return;
    }
    setAnglesLoading(true);
    setAnglesError(null);
    try {
      const res = await fetch('/api/videos/angles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Your notes guide the angles, but not the text an earlier angle wrote
        body: JSON.stringify({ topic, notes: angleBriefRef.current ? brief.replace(angleBriefRef.current, '') : brief, setup, targetMinutes: minutes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not find angles.');
      setAngles(data.angles ?? []);
      setChosenAngle(null);
    } catch (err) {
      setAnglesError(err instanceof Error ? err.message : 'Could not find angles.');
    } finally {
      setAnglesLoading(false);
    }
  }

  function chooseAngle(angle: VideoAngle) {
    const angleBrief = briefForAngle(angle);
    // Swap out the previous angle's lines; keep your own notes
    const own = (angleBriefRef.current ? brief.replace(angleBriefRef.current, '') : brief).trim();
    setBrief(own ? `${angleBrief}\n\n${own}` : angleBrief);
    angleBriefRef.current = angleBrief;
    setTopic(angle.title);
    setChosenAngle(angle.title);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>, type: 'raw' | 'srt') {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      if (type === 'raw') setRawText(text);
      else setSrtText(text);
      if (!topic) setTopic(file.name.replace(/\.[^/.]+$/, ''));
    } catch {
      setErrorMessage('Failed to read uploaded file.');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);
    if (!styles) {
      setErrorMessage(stylesError || 'Still loading the formats and niches.');
      return;
    }

    const payload: Record<string, unknown> = { setup };
    let url = '/api/videos';

    if (tab === 'ai') {
      if (!(minutes > 0 && minutes <= 60)) {
        setErrorMessage('Target length must be between 0.5 and 60 minutes.');
        return;
      }
      if (batchMode) {
        if (!batchList.length) {
          setErrorMessage('Add at least one topic, one per line.');
          return;
        }
        if (batchList.length > MAX_BATCH) {
          setErrorMessage(`Queue at most ${MAX_BATCH} topics at a time.`);
          return;
        }
        url = '/api/videos/batch';
        payload.topics = batchList;
      } else {
        if (!topic.trim()) {
          setErrorMessage('Please enter a video topic.');
          return;
        }
        payload.mode = 'ai';
        payload.topic = topic.trim();
      }
      payload.targetMinutes = minutes;
      if (brief.trim()) payload.brief = brief.trim();
    } else if (tab === 'raw') {
      if (!rawText.trim()) {
        setErrorMessage('Please paste or upload your script text.');
        return;
      }
      payload.mode = rawMode;
      payload.rawText = rawText.trim();
      payload.topic = topic.trim() || undefined;
    } else {
      if (!srtText.trim()) {
        setErrorMessage('Please paste or upload your SRT subtitle text.');
        return;
      }
      payload.mode = 'srt';
      payload.srtText = srtText.trim();
      payload.topic = topic.trim() || undefined;
      payload.minBeatDurationSeconds = smartMerge ? 4.0 : 0;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create the video.');
      remember(setup, minutes);
      if (url.endsWith('/batch')) router.push('/');
      else router.push(`/videos/${data.id}/review`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'An unexpected error occurred while creating the video.');
      setIsSubmitting(false);
    }
  }

  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`flex-1 py-2 px-3 text-xs font-medium rounded-lg transition ${tab === id ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'}`}
    >
      {label}
    </button>
  );

  const submitLabel =
    tab === 'ai'
      ? batchMode
        ? `Queue ${batchList.length || ''} video${batchList.length === 1 ? '' : 's'} →`.replace('  ', ' ')
        : brief.trim()
          ? 'Research & draft outline →'
          : 'Research & write script →'
      : tab === 'srt'
        ? 'Parse SRT & review script →'
        : 'Structure script & review →';

  const note = runtimeNote(minutes);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center py-12 px-4 sm:px-6 lg:px-8 font-sans">
      <div className="w-full max-w-3xl">
        <div className="flex items-center justify-between gap-2 text-sm text-zinc-400 mb-8">
          <div className="flex items-center gap-2">
            <Link href="/" className="hover:text-zinc-200 transition">
              Pipeline Dashboard
            </Link>
            <span>/</span>
            <span className="text-zinc-200 font-medium">New Video</span>
          </div>
          <Link href="/styles" className="text-xs text-indigo-400 hover:text-indigo-300">
            Packs &amp; voices →
          </Link>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-xl overflow-hidden">
          <div className="p-6 sm:p-8 border-b border-zinc-800/80 bg-gradient-to-b from-zinc-800/40 to-transparent">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold uppercase tracking-wider mb-3">
              Step 1 • Script Creation
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">Create New Video</h1>
            <p className="mt-1 text-sm text-zinc-400">Start from an idea, paste your own script, or upload SRT subtitles.</p>
            <div className="flex items-center gap-2 mt-6 p-1 bg-zinc-950 rounded-xl border border-zinc-800">
              {tabButton('ai', '🤖 From an idea')}
              {tabButton('raw', '📝 Paste a script')}
              {tabButton('srt', '⏱️ Upload SRT')}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="p-6 sm:p-8 space-y-7">
            {errorMessage && (
              <div className="p-4 rounded-xl bg-red-950/50 border border-red-800 text-red-200 text-sm flex items-start gap-3">
                <span className="text-red-400 font-bold shrink-0">⚠️</span>
                <span>{errorMessage}</span>
              </div>
            )}

            {tab === 'ai' && (
              <div className="space-y-6">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label htmlFor="topic" className="block text-sm font-medium text-zinc-200">
                      {batchMode ? 'Topics (one per line)' : 'Topic or working title'}
                    </label>
                    <button
                      type="button"
                      onClick={() => setBatchMode((b) => !b)}
                      className="text-xs text-indigo-400 hover:text-indigo-300"
                    >
                      {batchMode ? 'Just one topic' : 'Several topics at once'}
                    </button>
                  </div>
                  {batchMode ? (
                    <>
                      <textarea
                        id="topic"
                        rows={6}
                        value={batchTopics}
                        onChange={(e) => setBatchTopics(e.target.value)}
                        placeholder={'Why the Concorde was retired\nHow Singapore became rich\nThe rise and fall of BlackBerry'}
                        className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500 transition text-sm"
                      />
                      <p className={`text-xs mt-1.5 ${batchList.length > MAX_BATCH ? 'text-red-400' : 'text-zinc-500'}`}>
                        {batchList.length} topic{batchList.length === 1 ? '' : 's'} (up to {MAX_BATCH}). Each becomes its own video with the
                        same format, niche and length, researched and written in the background one after another.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <input
                          id="topic"
                          type="text"
                          value={topic}
                          onChange={(e) => setTopic(e.target.value)}
                          placeholder="e.g. the Concorde"
                          className="flex-1 min-w-0 px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500 transition text-sm"
                        />
                        <button
                          type="button"
                          onClick={findAngles}
                          disabled={anglesLoading || !styles}
                          className="shrink-0 px-4 rounded-xl border border-indigo-500/40 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/20 text-sm font-medium disabled:opacity-50 transition"
                        >
                          {anglesLoading ? 'Thinking…' : angles.length ? 'More angles' : '✨ Find angles'}
                        </button>
                      </div>
                      <p className="text-xs text-zinc-500 mt-1.5">
                        Type a rough topic and find angles: each comes with the title, hook and thumbnail it would be packaged with.
                      </p>
                      {anglesError && <p className="text-xs text-red-400 mt-2">{anglesError}</p>}
                      {angles.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                          {angles.map((a) => (
                            <button key={a.title} type="button" onClick={() => chooseAngle(a)} className={card(chosenAngle === a.title)}>
                              <div className="flex items-start justify-between gap-2">
                                <span className="font-semibold text-sm text-zinc-100 leading-snug">{a.title}</span>
                                <span className="shrink-0 text-[10px] uppercase tracking-wider text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 rounded px-1.5 py-0.5">
                                  {a.kind}
                                </span>
                              </div>
                              {a.hook && <p className="text-xs text-zinc-300 mt-2 italic">“{a.hook}”</p>}
                              <p className="text-[11px] text-zinc-400 mt-2">{a.angle}</p>
                              {a.thumbnail && (
                                <p className="text-[11px] text-zinc-500 mt-1.5">
                                  🖼️ {a.thumbnail}
                                  {a.thumbnail_text ? ` · “${a.thumbnail_text}”` : ''}
                                </p>
                              )}
                              {chosenAngle === a.title && <p className="text-[11px] text-indigo-300 mt-2 font-medium">✓ Using this angle (added to your brief)</p>}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div>
                  <span className="block text-sm font-medium text-zinc-200 mb-2">Length</span>
                  <div className="flex flex-wrap gap-2">
                    {RUNTIME_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => chooseMinutes(p.minutes)}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
                          !customMinutes && Math.abs(minutes - p.minutes) < 0.01
                            ? 'border-indigo-500 bg-indigo-500/15 text-white'
                            : 'border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-700'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => chooseMinutes(minutes, true)}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
                        customMinutes || !presetFor(minutes) ? 'border-indigo-500 bg-indigo-500/15 text-white' : 'border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      Custom
                    </button>
                    {(customMinutes || !presetFor(minutes)) && (
                      <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
                        <input
                          type="number"
                          min="0.5"
                          max="60"
                          step="0.5"
                          value={minutes}
                          onChange={(e) => chooseMinutes(parseFloat(e.target.value) || 0, true)}
                          className="w-20 px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-xs"
                        />
                        min
                      </span>
                    )}
                  </div>
                  {note && <p className="text-xs text-zinc-500 mt-2">{note}</p>}
                  {format && !runtimeTouched && (
                    <p className="text-xs text-zinc-500 mt-1">Set from the {format.name} format’s usual length.</p>
                  )}
                </div>

                <div>
                  <label htmlFor="brief" className="block text-sm font-medium text-zinc-200 mb-1">
                    {batchMode ? 'Shared notes' : 'Brief / outline'} <span className="text-zinc-500 font-normal">(optional)</span>
                  </label>
                  <p className="text-xs text-zinc-500 mb-2">
                    {batchMode
                      ? 'Notes that apply to every topic (tone, lines to avoid, sources). With notes, each video stops at an outline for you to approve.'
                      : 'Your notes: angle, chapters, facts, lines you want said, title or thumbnail ideas, sources. With a brief you get an outline to approve before the full script is written.'}
                  </p>
                  <textarea
                    id="brief"
                    rows={7}
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    placeholder={'e.g.\nAngle: the rise and fall of...\nChapter 1: ...\nOpen with: "..."\nTitle idea: ...\nSources: ...'}
                    className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500 transition text-xs leading-relaxed"
                  />
                </div>
              </div>
            )}

            {tab === 'raw' && (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-zinc-200 mb-2">Video topic / title (optional)</label>
                  <input
                    type="text"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="e.g. My Script Title"
                    className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 text-sm"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-zinc-200">Narration script text</label>
                    <label className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer font-medium">
                      📁 Upload .txt or .md
                      <input type="file" accept=".txt,.md" onChange={(e) => handleFileUpload(e, 'raw')} className="hidden" />
                    </label>
                  </div>
                  <textarea
                    rows={8}
                    value={rawText}
                    onChange={(e) => setRawText(e.target.value)}
                    placeholder="Paste your full narration script here. Separate scenes with blank lines..."
                    className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 font-mono text-xs leading-relaxed"
                  />
                  <p className="text-xs text-zinc-500 mt-1.5">The video’s length comes from your text.</p>
                </div>
                <div className="p-4 bg-zinc-950/60 border border-zinc-800/80 rounded-xl space-y-3">
                  <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">Splitting into beats</span>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="radio" name="rawMode" checked={rawMode === 'raw_paragraphs'} onChange={() => setRawMode('raw_paragraphs')} className="mt-1" />
                    <div>
                      <span className="text-xs font-semibold text-zinc-200 block">Instant paragraph split (no AI)</span>
                      <span className="text-xs text-zinc-400">Each blank line becomes a beat, exactly as you wrote it.</span>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="radio" name="rawMode" checked={rawMode === 'raw_ai'} onChange={() => setRawMode('raw_ai')} className="mt-1" />
                    <div>
                      <span className="text-xs font-semibold text-zinc-200 block">AI beats and shot plan</span>
                      <span className="text-xs text-zinc-400">Splits your text into balanced spoken beats and plans the shots, in the background.</span>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {tab === 'srt' && (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-zinc-200 mb-2">Video title (optional)</label>
                  <input
                    type="text"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="e.g. Subtitle Project"
                    className="w-full px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 text-sm"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-zinc-200">SRT subtitle content</label>
                    <label className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer font-medium">
                      📁 Upload .srt file
                      <input type="file" accept=".srt" onChange={(e) => handleFileUpload(e, 'srt')} className="hidden" />
                    </label>
                  </div>
                  <textarea
                    rows={8}
                    value={srtText}
                    onChange={(e) => setSrtText(e.target.value)}
                    placeholder={`1\n00:00:01,000 --> 00:00:04,500\nWelcome to this video tutorial.\n\n2\n00:00:04,600 --> 00:00:09,000\nToday we explore video automation.`}
                    className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 font-mono text-xs leading-relaxed"
                  />
                </div>
                <div className="p-4 bg-zinc-950/60 border border-zinc-800/80 rounded-xl">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={smartMerge} onChange={(e) => setSmartMerge(e.target.checked)} />
                    <div>
                      <span className="text-xs font-semibold text-zinc-200 block">Smart scene merging (recommended)</span>
                      <span className="text-xs text-zinc-400">Combines short 1–2s subtitle cues into natural 4–8s beats based on sentences.</span>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {/* STYLE: niche, format, more options */}
            <div className="pt-5 border-t border-zinc-800/60 space-y-6">
              {stylesError && <p className="text-sm text-red-400">{stylesError}</p>}
              {!styles && !stylesError && <p className="text-sm text-zinc-500">Loading formats and niches…</p>}

              {styles && (
                <>
                  {recent.length > 0 && (
                    <div className="flex items-center gap-2 text-xs text-zinc-400">
                      <label htmlFor="startFrom">Start from a previous video’s setup:</label>
                      <select
                        id="startFrom"
                        value=""
                        onChange={(e) => startFrom(e.target.value)}
                        className="min-w-0 flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-zinc-200"
                      >
                        <option value="">Choose…</option>
                        {recent.map((v) => {
                          const s = setupForVideo(v);
                          const f = styles.formats.find((x) => x.id === s.format)?.name ?? s.format;
                          const n = styles.niches.find((x) => x.id === s.niche)?.name ?? s.niche;
                          return (
                            <option key={v.id} value={v.id}>
                              {(v.title || v.topic || 'Untitled').slice(0, 60)} · {f}
                              {s.niche === 'general' ? '' : ` / ${n}`}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  )}

                  <div>
                    <span className="block text-sm font-medium text-zinc-200">What’s it about?</span>
                    <span className="block text-xs text-zinc-500 mb-3">The niche: subject rules, look, footage and music mood.</span>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      {styles.niches.map((n) => (
                        <button key={n.id} type="button" onClick={() => updateSetup({ niche: n.id })} className={card(setup.niche === n.id)}>
                          <span className="font-semibold text-xs text-zinc-100 flex items-center gap-1.5">
                            <span>{n.icon}</span>
                            <span className="truncate">{n.name}</span>
                            {n.custom && <span className="ml-auto text-[10px] text-amber-300">yours</span>}
                          </span>
                          <p className="text-[11px] text-zinc-400 leading-snug mt-1">{n.description}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <span className="block text-sm font-medium text-zinc-200">How is it built?</span>
                    <span className="block text-xs text-zinc-500 mb-3">The format: structure, pacing and emphasis. Suggested ones for {niche?.name ?? 'this niche'} come first.</span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {orderedFormats.map((f) => {
                        const suggested = niche?.suggestedFormats.includes(f.id);
                        return (
                          <button key={f.id} type="button" onClick={() => updateSetup({ format: f.id })} className={card(setup.format === f.id)}>
                            <span className="font-semibold text-xs text-zinc-100 flex items-center gap-1.5">
                              <span>{f.icon}</span>
                              <span>{f.name}</span>
                              {suggested && niche?.id !== 'general' && (
                                <span className="text-[10px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5">suggested</span>
                              )}
                              {f.custom && <span className="ml-auto text-[10px] text-amber-300">yours</span>}
                            </span>
                            <p className="text-[11px] text-zinc-400 leading-snug mt-1">{f.description}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/40">
                    <button
                      type="button"
                      onClick={() => setShowMore((s) => !s)}
                      className="w-full flex items-center justify-between px-4 py-3 text-sm text-zinc-200"
                    >
                      <span>
                        More options{' '}
                        <span className="text-xs text-zinc-500">
                          · look: {styles.looks.find((l) => l.id === setup.look)?.name} · audience: {setup.audience}
                          {setup.voiceId ? ` · voice: ${styles.voices.find((v) => v.id === setup.voiceId)?.name}` : ''}
                        </span>
                      </span>
                      <span className="text-zinc-500">{showMore ? '▲' : '▼'}</span>
                    </button>
                    {showMore && (
                      <div className="px-4 pb-4 space-y-5">
                        <div>
                          <span className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Look</span>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            {styles.looks.map((l) => (
                              <button key={l.id} type="button" onClick={() => updateSetup({ look: l.id })} className={card(setup.look === l.id)}>
                                <span className="text-xs font-semibold text-zinc-100">{l.name}</span>
                                <p className="text-[11px] text-zinc-400 leading-snug mt-0.5">{l.description}</p>
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <span className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Audience</span>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            {styles.audiences.map((a) => (
                              <button key={a.id} type="button" onClick={() => updateSetup({ audience: a.id })} className={card(setup.audience === a.id)}>
                                <span className="text-xs font-semibold text-zinc-100">{a.name}</span>
                                <p className="text-[11px] text-zinc-400 leading-snug mt-0.5">{a.description}</p>
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <span className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Your voice</span>
                          {styles.voices.length ? (
                            <select
                              value={setup.voiceId ?? ''}
                              onChange={(e) => updateSetup({ voiceId: e.target.value || null })}
                              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200"
                            >
                              <option value="">None: the format and niche’s own voice</option>
                              {styles.voices.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <p className="text-xs text-zinc-500">
                              No saved voices yet.{' '}
                              <Link href="/styles#voices" className="text-indigo-400 hover:text-indigo-300">
                                Derive one from your scripts →
                              </Link>
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="pt-1 space-y-3">
              {composed && (
                <div className="text-xs text-zinc-400 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>
                    <span className="text-zinc-500">Style:</span> <span className="text-zinc-200 font-medium">{composed.pack.label}</span>
                  </span>
                  {estimate && <span className="text-zinc-500">{describeEstimate(estimate)}</span>}
                </div>
              )}
              <button
                type="submit"
                disabled={isSubmitting || !styles}
                className="w-full py-3.5 px-6 rounded-xl bg-gradient-to-r from-red-600 to-indigo-600 hover:from-red-500 hover:to-indigo-500 text-white font-semibold text-sm transition shadow-lg shadow-indigo-900/30 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    <span>Starting…</span>
                  </>
                ) : (
                  <span>{submitLabel}</span>
                )}
              </button>
              {tab !== 'srt' && !(tab === 'raw' && rawMode === 'raw_paragraphs') && (
                <p className="text-[11px] text-zinc-500 text-center">
                  Writing runs in the background: you can leave the page, and follow it on the review page or the dashboard.
                </p>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
