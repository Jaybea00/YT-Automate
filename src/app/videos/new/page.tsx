'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { STYLE_GROUP_LABELS, STYLE_PACKS, type StyleGroup, type VideoStyle } from '@/lib/styles/packs';

type CreationMode = 'ai' | 'raw_paragraphs' | 'raw_ai' | 'srt';

export default function NewVideoPage() {
  const router = useRouter();

  // Active Tab
  const [activeTab, setActiveTab] = useState<'ai' | 'raw' | 'srt'>('ai');

  // Form State
  const [topic, setTopic] = useState('');
  const [style, setStyle] = useState<VideoStyle>('tech');
  const [targetMinutes, setTargetMinutes] = useState<number | string>(5);

  // Raw Script State
  const [rawText, setRawText] = useState('');
  const [rawMode, setRawMode] = useState<'raw_paragraphs' | 'raw_ai'>('raw_paragraphs');

  // SRT State
  const [srtText, setSrtText] = useState('');
  const [smartMerge, setSmartMerge] = useState(true);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const styleGroups = (Object.keys(STYLE_GROUP_LABELS) as StyleGroup[]).map((group) => ({
    group,
    packs: Object.values(STYLE_PACKS).filter((p) => p.group === group),
  }));

  async function handleFileUpload(
    e: React.ChangeEvent<HTMLInputElement>,
    type: 'raw' | 'srt',
  ) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      if (type === 'raw') {
        setRawText(text);
        if (!topic) {
          setTopic(file.name.replace(/\.[^/.]+$/, ''));
        }
      } else {
        setSrtText(text);
        if (!topic) {
          setTopic(file.name.replace(/\.[^/.]+$/, ''));
        }
      }
    } catch {
      setErrorMessage('Failed to read uploaded file.');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    let mode: CreationMode = 'ai';
    const payload: Record<string, unknown> = { style };

    if (activeTab === 'ai') {
      mode = 'ai';
      if (!topic.trim()) {
        setErrorMessage('Please enter a video topic.');
        return;
      }
      const parsedMinutes = parseFloat(String(targetMinutes));
      if (isNaN(parsedMinutes) || parsedMinutes <= 0) {
        setErrorMessage('Target duration must be at least 0.5 minutes.');
        return;
      }
      payload.topic = topic.trim();
      payload.targetMinutes = parsedMinutes;
    } else if (activeTab === 'raw') {
      mode = rawMode;
      if (!rawText.trim()) {
        setErrorMessage('Please paste or upload your script text.');
        return;
      }
      payload.rawText = rawText.trim();
      payload.topic = topic.trim() || undefined;
      payload.targetMinutes = targetMinutes ? parseFloat(String(targetMinutes)) : 3;
    } else if (activeTab === 'srt') {
      mode = 'srt';
      if (!srtText.trim()) {
        setErrorMessage('Please paste or upload your SRT subtitle text.');
        return;
      }
      payload.srtText = srtText.trim();
      payload.topic = topic.trim() || undefined;
      payload.minBeatDurationSeconds = smartMerge ? 4.0 : 0;
    }

    payload.mode = mode;
    setIsSubmitting(true);

    try {
      const res = await fetch('/api/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to process script.');
      }

      router.push(`/videos/${data.id}/review`);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'An unexpected error occurred while creating video.',
      );
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center py-12 px-4 sm:px-6 lg:px-8 font-sans">
      <div className="w-full max-w-2xl">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-zinc-400 mb-8">
          <Link href="/" className="hover:text-zinc-200 transition">
            Pipeline Dashboard
          </Link>
          <span>/</span>
          <span className="text-zinc-200 font-medium">New Video</span>
        </div>

        {/* Card Container */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-xl overflow-hidden">
          <div className="p-6 sm:p-8 border-b border-zinc-800/80 bg-gradient-to-b from-zinc-800/40 to-transparent">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold uppercase tracking-wider mb-3">
              Step 1 • Script Creation
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
              Create New Video Script
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              Generate from an idea, paste your pre-written script, or upload existing SRT subtitles.
            </p>

            {/* Mode Tabs */}
            <div className="flex items-center gap-2 mt-6 p-1 bg-zinc-950 rounded-xl border border-zinc-800">
              <button
                type="button"
                onClick={() => setActiveTab('ai')}
                className={`flex-1 py-2 px-3 text-xs font-medium rounded-lg transition ${
                  activeTab === 'ai'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                🤖 AI Generator
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('raw')}
                className={`flex-1 py-2 px-3 text-xs font-medium rounded-lg transition ${
                  activeTab === 'raw'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                📝 Paste / Text Script
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('srt')}
                className={`flex-1 py-2 px-3 text-xs font-medium rounded-lg transition ${
                  activeTab === 'srt'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                ⏱️ Upload SRT
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="p-6 sm:p-8 space-y-6">
            {errorMessage && (
              <div className="p-4 rounded-xl bg-red-950/50 border border-red-800 text-red-200 text-sm flex items-start gap-3">
                <span className="text-red-400 font-bold shrink-0">⚠️</span>
                <span>{errorMessage}</span>
              </div>
            )}

            {/* TAB 1: AI GENERATOR */}
            {activeTab === 'ai' && (
              <div className="space-y-6">
                <div>
                  <label htmlFor="topic" className="block text-sm font-medium text-zinc-200 mb-2">
                    Video Topic or Working Title
                  </label>
                  <input
                    id="topic"
                    type="text"
                    required
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="e.g. Why Postgres is Dominating Database Architecture in 2026"
                    className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500 transition text-sm"
                  />
                </div>

                <div>
                  <label htmlFor="targetMinutes" className="block text-sm font-medium text-zinc-200 mb-2">
                    Target Runtime (Minutes)
                  </label>
                  <input
                    id="targetMinutes"
                    type="number"
                    min="0.5"
                    max="60"
                    step="0.5"
                    required
                    value={targetMinutes}
                    onChange={(e) => setTargetMinutes(e.target.value)}
                    className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500 transition text-sm"
                  />
                </div>
              </div>
            )}

            {/* TAB 2: RAW SCRIPT */}
            {activeTab === 'raw' && (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-zinc-200 mb-2">
                    Video Topic / Title (optional)
                  </label>
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
                    <label className="block text-sm font-medium text-zinc-200">
                      Narration Script Text
                    </label>
                    <label className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer font-medium">
                      📁 Upload .txt or .md
                      <input
                        type="file"
                        accept=".txt,.md"
                        onChange={(e) => handleFileUpload(e, 'raw')}
                        className="hidden"
                      />
                    </label>
                  </div>
                  <textarea
                    rows={8}
                    required
                    value={rawText}
                    onChange={(e) => setRawText(e.target.value)}
                    placeholder="Paste your full narration script here. Separate scenes with blank lines..."
                    className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 font-mono text-xs leading-relaxed"
                  />
                </div>

                {/* Parsing Method Choice */}
                <div className="p-4 bg-zinc-950/60 border border-zinc-800/80 rounded-xl space-y-3">
                  <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">
                    Segmentation Strategy
                  </span>
                  <div className="space-y-2">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="radio"
                        name="rawMode"
                        checked={rawMode === 'raw_paragraphs'}
                        onChange={() => setRawMode('raw_paragraphs')}
                        className="mt-1 text-indigo-600 focus:ring-0"
                      />
                      <div>
                        <span className="text-xs font-semibold text-zinc-200 block">
                          Instant Paragraph Split (Zero AI)
                        </span>
                        <span className="text-xs text-zinc-400">
                          Each blank line becomes a beat. Preserves your exact paragraph layout instantly.
                        </span>
                      </div>
                    </label>
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="radio"
                        name="rawMode"
                        checked={rawMode === 'raw_ai'}
                        onChange={() => setRawMode('raw_ai')}
                        className="mt-1 text-indigo-600 focus:ring-0"
                      />
                      <div>
                        <span className="text-xs font-semibold text-zinc-200 block">
                          AI Beat Segmentation & Visual Queries
                        </span>
                        <span className="text-xs text-zinc-400">
                          LLM segments text into balanced 10–25 word spoken beats and suggests visual hints.
                        </span>
                      </div>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: SRT SUBTITLES */}
            {activeTab === 'srt' && (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-zinc-200 mb-2">
                    Video Title (optional)
                  </label>
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
                    <label className="block text-sm font-medium text-zinc-200">
                      SRT Subtitle Content
                    </label>
                    <label className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer font-medium">
                      📁 Upload .srt File
                      <input
                        type="file"
                        accept=".srt"
                        onChange={(e) => handleFileUpload(e, 'srt')}
                        className="hidden"
                      />
                    </label>
                  </div>
                  <textarea
                    rows={8}
                    required
                    value={srtText}
                    onChange={(e) => setSrtText(e.target.value)}
                    placeholder={`1\n00:00:01,000 --> 00:00:04,500\nWelcome to this video tutorial.\n\n2\n00:00:04,600 --> 00:00:09,000\nToday we explore video automation.`}
                    className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 font-mono text-xs leading-relaxed"
                  />
                </div>

                <div className="p-4 bg-zinc-950/60 border border-zinc-800/80 rounded-xl">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={smartMerge}
                      onChange={(e) => setSmartMerge(e.target.checked)}
                      className="rounded text-indigo-600 focus:ring-0"
                    />
                    <div>
                      <span className="text-xs font-semibold text-zinc-200 block">
                        Smart Scene Merging (Recommended)
                      </span>
                      <span className="text-xs text-zinc-400">
                        Combines short 1–2s subtitle cues into natural 4–8s scene beats based on sentences.
                      </span>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {/* STYLE SELECTION (Shared across all modes) */}
            <div className="pt-2 border-t border-zinc-800/60">
              <label className="block text-sm font-medium text-zinc-200 mb-3">
                Narration Tone & Pacing Template
              </label>
              <div className="space-y-5">
                {styleGroups.map(({ group, packs }) => (
                  <div key={group}>
                    <span className="block text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">{STYLE_GROUP_LABELS[group]}</span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {packs.map((pack) => {
                        const isSelected = style === pack.id;
                        return (
                          <div
                            key={pack.id}
                            onClick={() => setStyle(pack.id as VideoStyle)}
                            className={`p-3.5 rounded-xl border cursor-pointer transition flex flex-col justify-between ${
                              isSelected
                                ? 'border-indigo-500 bg-indigo-500/10'
                                : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="font-semibold text-xs text-zinc-100 flex items-center gap-1.5">
                                <span>{pack.icon}</span>
                                <span>{pack.name}</span>
                              </span>
                              {isSelected && (
                                <span className="text-indigo-400 font-bold text-xs bg-indigo-500/20 px-1.5 py-0.5 rounded">✓</span>
                              )}
                            </div>
                            <p className="text-[11px] text-zinc-400 leading-relaxed">{pack.description}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Submit Button */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3.5 px-6 rounded-xl bg-gradient-to-r from-red-600 to-indigo-600 hover:from-red-500 hover:to-indigo-500 text-white font-semibold text-sm transition shadow-lg shadow-indigo-900/30 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    <span>Processing Script...</span>
                  </>
                ) : (
                  <span>
                    {activeTab === 'ai'
                      ? 'Generate Script with AI →'
                      : activeTab === 'srt'
                      ? 'Parse SRT & Review Script →'
                      : 'Structure Script & Review →'}
                  </span>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
