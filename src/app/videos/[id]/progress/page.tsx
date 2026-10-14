'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

interface VideoData {
  id: string;
  title: string | null;
  topic: string | null;
  status: string;
  render_url: string | null;
  error_message: string | null;
  bgm_track?: string | null;
  script_json?: any;
}

interface ChapterItem {
  beatIndex: number;
  startTimeMs: number;
  startTimeSeconds: number;
  timestamp: string;
  title: string;
  durationMs: number;
  isMeasured: boolean;
}

interface ChaptersData {
  videoId: string;
  videoTitle: string | null;
  chapters: ChapterItem[];
  formattedText: string;
  totalDurationSeconds: number;
  totalDurationFormatted: string;
  hasMeasuredDurations: boolean;
  customTitles: Record<number, string>;
  /** Music and visual credits the description must carry. */
  creditsText?: string;
}

interface JobData {
  id: string;
  status: 'queued' | 'running' | 'failed' | 'done' | 'cancelled';
  stages: string[];
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface StageData {
  id: string;
  stage: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

interface UnitData {
  id: string;
  stage: string;
  unit_index: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  duration_ms: number | null;
  cost_usd: number | null;
  attempts: number;
  error: string | null;
  output_path: string | null;
}

interface VideoAssetData {
  id: string;
  video_id: string;
  beat_index: number;
  visual_type: 'chart' | 'screen_recording' | 'stock' | string;
  source_url: string | null;
  license_type: string | null;
  license_source: string | null;
  attribution_text: string | null;
  license_proof_url: string | null;
  created_at?: string;
}

interface ProgressResponse {
  video: VideoData;
  job: JobData | null;
  stages: StageData[];
  units: UnitData[];
  assets?: VideoAssetData[];
  error?: string;
}

export default function PipelineProgressPage() {
  const params = useParams();
  const id = params?.id as string;

  const [data, setData] = useState<ProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<'all' | 'visuals' | 'tts'>('all');
  const [isTriggering, setIsTriggering] = useState(false);

  // YouTube Chapters State
  const [chaptersData, setChaptersData] = useState<ChaptersData | null>(null);
  const [copiedChapters, setCopiedChapters] = useState(false);
  const [copiedCredits, setCopiedCredits] = useState(false);
  const [formatStyle, setFormatStyle] = useState<'dash' | 'space'>('dash');
  const [editingTitles, setEditingTitles] = useState<Record<number, string>>({});
  const [isSavingTitles, setIsSavingTitles] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const fetchChapters = useCallback(
    async (style: 'dash' | 'space' = formatStyle) => {
      if (!id) return;
      try {
        const res = await fetch(`/api/videos/${id}/chapters?style=${style}`);
        if (res.ok) {
          const json: ChaptersData = await res.json();
          setChaptersData(json);
          if (json.customTitles) {
            setEditingTitles((prev) => ({ ...json.customTitles, ...prev }));
          }
        }
      } catch {
        // Non-blocking
      }
    },
    [id, formatStyle],
  );

  const fetchProgress = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/videos/${id}/progress`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }
      const json: ProgressResponse = await res.json();
      setData(json);
      setError(null);
      // Also update chapters with fresh data
      fetchChapters();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load progress');
    } finally {
      setLoading(false);
    }
  }, [id, fetchChapters]);

  useEffect(() => {
    fetchProgress();
    fetchChapters();
  }, [fetchProgress, fetchChapters]);

  function handleFormatChange(newStyle: 'dash' | 'space') {
    setFormatStyle(newStyle);
    fetchChapters(newStyle);
  }

  async function handleSaveChapters() {
    if (!id) return;
    setIsSavingTitles(true);
    try {
      const res = await fetch(`/api/videos/${id}/chapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customTitles: editingTitles, style: formatStyle }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to save chapters');
      }
      const json: ChaptersData = await res.json();
      setChaptersData(json);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save chapters');
    } finally {
      setIsSavingTitles(false);
    }
  }

  async function handleCopyChapters() {
    if (!chaptersData?.formattedText) return;
    try {
      await navigator.clipboard.writeText(chaptersData.formattedText);
      setCopiedChapters(true);
      setTimeout(() => setCopiedChapters(false), 2500);
    } catch {
      // Fallback
    }
  }

  async function handleCopyCredits() {
    if (!chaptersData?.creditsText) return;
    try {
      await navigator.clipboard.writeText(chaptersData.creditsText);
      setCopiedCredits(true);
      setTimeout(() => setCopiedCredits(false), 2500);
    } catch {
      // Clipboard unavailable; the text is selectable
    }
  }

  function handleSeekVideo(seconds: number) {
    const videoEl = document.getElementById('final-video-player') as HTMLVideoElement | null;
    if (videoEl) {
      videoEl.currentTime = seconds;
      videoEl.play().catch(() => {});
      videoEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Auto-poll every 3s if job is queued or running, or video is in an active state
  useEffect(() => {
    const isJobActive =
      data?.job?.status === 'queued' || data?.job?.status === 'running';
    const isVideoActive =
      data?.video?.status === 'voicing' ||
      data?.video?.status === 'sourcing' ||
      data?.video?.status === 'assembling';

    if (isJobActive || isVideoActive) {
      const timer = setInterval(() => {
        fetchProgress();
      }, 3000);
      return () => clearInterval(timer);
    }
  }, [data?.job?.status, data?.video?.status, fetchProgress]);

  async function handleStartVoicing() {
    setIsTriggering(true);
    try {
      const res = await fetch(`/api/videos/${id}/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Failed to start voicing (HTTP ${res.status})`);
      }
      await fetchProgress();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error starting voicing');
    } finally {
      setIsTriggering(false);
    }
  }

  async function handleStartAssembly() {
    setIsTriggering(true);
    try {
      const res = await fetch(`/api/videos/${id}/assembly`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Failed to start assembly (HTTP ${res.status})`);
      }
      await fetchProgress();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error starting assembly');
    } finally {
      setIsTriggering(false);
    }
  }

  const video = data?.video;
  const qualityReport = video?.script_json?.quality_report as
    | { passed: boolean; checkedAt: string; checks: Array<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string }> }
    | undefined;
  const job = data?.job;
  const stages = data?.stages || [];
  const units = data?.units || [];
  const assets = data?.assets || [];

  const completedUnits = units.filter((u) => u.status === 'done').length;
  const totalUnits = units.length;
  const totalCost = units.reduce((acc, u) => acc + (Number(u.cost_usd) || 0), 0);

  const ttsUnitsCount = units.filter((u) => u.stage === 'tts').length;
  const visualsUnitsCount = units.filter((u) => u.stage === 'visuals').length;

  const filteredUnits = units.filter((u) => {
    if (stageFilter === 'all') return true;
    return u.stage === stageFilter;
  });

  const isRendering =
    video?.status === 'assembling' ||
    video?.status === 'rendering' ||
    (job?.stages?.includes('assembly') && job?.status === 'running');

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 md:p-10 font-sans">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            <Link
              href={`/videos/${id}/review`}
              className="hover:text-zinc-200 transition-colors flex items-center gap-1"
            >
              ← Back to Script Review
            </Link>
            <span>•</span>
            <Link
              href={`/videos/${id}/visuals`}
              className="text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1 font-medium"
            >
              Manual Visuals →
            </Link>
          </div>
          <button
            onClick={() => fetchProgress()}
            className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition"
          >
            Refresh
          </button>
        </div>

        {/* Video Header Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${
                    video?.status === 'rendered'
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : video?.status === 'failed'
                      ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                      : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  }`}
                >
                  Status: {video?.status || 'Unknown'}
                </span>
                {job && (
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-xs font-mono border ${
                      job.status === 'done'
                        ? 'bg-emerald-950 border-emerald-800 text-emerald-400'
                        : job.status === 'failed'
                        ? 'bg-rose-950 border-rose-800 text-rose-400'
                        : 'bg-zinc-800 border-zinc-700 text-zinc-300'
                    }`}
                  >
                    Job: {job.status}
                  </span>
                )}
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white">
                {video?.title || 'Video Pipeline Progress'}
              </h1>
              {video?.topic && (
                <p className="text-zinc-400 text-sm mt-1">Topic: {video.topic}</p>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={`/videos/${id}/visuals`}
                className="px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 font-medium text-sm transition"
              >
                Manage Visuals
              </Link>
              <Link
                href={`/videos/${id}/vibedit`}
                className="px-4 py-2.5 rounded-xl bg-indigo-950 hover:bg-indigo-900 border border-indigo-700/80 text-indigo-200 font-medium text-sm transition flex items-center gap-1.5 shadow-md shadow-indigo-950/50"
              >
                <span>🎬</span>
                <span>Vibedit Studio</span>
              </Link>
              {video?.status !== 'rendered' && (
                <button
                  onClick={handleStartAssembly}
                  disabled={isTriggering || isRendering}
                  className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-sm transition shadow-lg shadow-indigo-900/40"
                >
                  {isTriggering || isRendering ? 'Assembling Video...' : 'Start Assembly'}
                </button>
              )}
              {!job && (
                <button
                  onClick={handleStartVoicing}
                  disabled={isTriggering}
                  className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-sm transition shadow-lg shadow-emerald-900/40"
                >
                  {isTriggering ? 'Starting...' : 'Start Voicing Pipeline'}
                </button>
              )}
              {job?.status === 'failed' && (
                <button
                  onClick={handleStartVoicing}
                  disabled={isTriggering}
                  className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-medium text-sm transition"
                >
                  {isTriggering ? 'Retrying...' : 'Retry Job'}
                </button>
              )}
            </div>
          </div>

          {/* Error Banner */}
          {(video?.error_message || job?.error || error) && (
            <div className="mt-6 p-4 rounded-xl bg-rose-950/40 border border-rose-800 text-rose-300 text-sm">
              <span className="font-semibold">Pipeline Error:</span>{' '}
              {job?.error || video?.error_message || error}
            </div>
          )}

          {/* Rendered Video Player / Output */}
          {(video?.render_url || video?.status === 'rendered') && (
            <div className="mt-6 p-5 sm:p-6 rounded-2xl bg-zinc-950/90 border border-emerald-800/80 shadow-2xl space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Final Video Rendered Successfully</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={`/api/videos/${id}/render`}
                    download={`${video?.title || 'video'}.mp4`}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition shadow-md shadow-emerald-950"
                  >
                    ⬇ Download MP4
                  </a>
                  <a
                    href={`/api/videos/${id}/subtitles?format=srt&download=1`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 transition shadow-sm"
                    title="Download YouTube SRT Subtitles"
                  >
                    💬 Download .SRT
                  </a>
                  <a
                    href={`/api/videos/${id}/subtitles?format=vtt&download=1`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 transition shadow-sm"
                    title="Download WebVTT Subtitles"
                  >
                    📄 .VTT
                  </a>
                  <a
                    href={`/api/videos/${id}/render`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium border border-zinc-700 transition"
                  >
                    ↗ Open Tab
                  </a>
                </div>
              </div>

              {/* HTML5 Video Player with HTTP 206 Range Stream and Closed Captions Track */}
              <div className="relative rounded-xl overflow-hidden bg-black border border-zinc-800 shadow-inner aspect-video">
                <video
                  id="final-video-player"
                  controls
                  playsInline
                  preload="metadata"
                  className="w-full h-full object-contain"
                  src={`/api/videos/${id}/render`}
                >
                  <track
                    kind="subtitles"
                    src={`/api/videos/${id}/subtitles?format=vtt`}
                    srcLang="en"
                    label="English"
                    default
                  />
                  Your browser does not support the video tag.
                </video>
              </div>

              <div className="flex items-center justify-between text-xs text-zinc-400 font-mono">
                <span>Stream endpoint: /api/videos/{id}/render</span>
                <div className="flex items-center gap-3">
                  {video?.bgm_track && video.bgm_track !== 'none' && (
                    <span className="text-indigo-400 font-sans font-medium flex items-center gap-1">
                      <span>🎵</span> BGM: {video.bgm_track}
                    </span>
                  )}
                  <span>1080p H.264 / AAC (48kHz)</span>
                </div>
              </div>
            </div>
          )}

          {/* YouTube Chapters Section */}
          {chaptersData && chaptersData.chapters.length > 0 && (
            <div className="mt-6 p-5 sm:p-6 rounded-2xl bg-zinc-950/90 border border-zinc-800 shadow-2xl space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800/80 pb-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">📑</span>
                    <h3 className="text-base font-bold text-white tracking-tight">
                      YouTube Chapter Timestamps
                    </h3>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                        chaptersData.hasMeasuredDurations
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                      }`}
                    >
                      {chaptersData.hasMeasuredDurations
                        ? '✓ Verified (Measured Voiceover)'
                        : '⚡ Estimated (Script Timing)'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400">
                    Paste these timestamps directly into your YouTube description. Timestamps start at 00:00 for automatic chapter segmentation.
                  </p>
                </div>

                <div className="flex items-center gap-2 self-start sm:self-auto">
                  {/* Format toggle */}
                  <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => handleFormatChange('dash')}
                      className={`px-2.5 py-1 rounded-md transition font-medium ${
                        formatStyle === 'dash'
                          ? 'bg-zinc-800 text-white shadow-sm'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                      title="00:00 - Introduction"
                    >
                      Dash (-)
                    </button>
                    <button
                      type="button"
                      onClick={() => handleFormatChange('space')}
                      className={`px-2.5 py-1 rounded-md transition font-medium ${
                        formatStyle === 'space'
                          ? 'bg-zinc-800 text-white shadow-sm'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                      title="00:00 Introduction"
                    >
                      Space
                    </button>
                  </div>

                  {/* Copy Button */}
                  <button
                    type="button"
                    onClick={handleCopyChapters}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition shadow-md ${
                      copiedChapters
                        ? 'bg-emerald-600 text-white'
                        : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-950'
                    }`}
                  >
                    {copiedChapters ? (
                      <>
                        <span>✓</span>
                        <span>Copied to Clipboard!</span>
                      </>
                    ) : (
                      <>
                        <span>📋</span>
                        <span>Copy for Description</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Chapter Items List */}
              <div className="space-y-2">
                <div className="grid grid-cols-12 gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 px-3">
                  <span className="col-span-3 sm:col-span-2">Timestamp</span>
                  <span className="col-span-2 sm:col-span-2">Beat</span>
                  <span className="col-span-5 sm:col-span-6">Chapter Title (Editable)</span>
                  <span className="col-span-2 text-right">Duration</span>
                </div>

                <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                  {chaptersData.chapters.map((ch) => {
                    const currentTitle = editingTitles[ch.beatIndex] ?? ch.title;
                    return (
                      <div
                        key={ch.beatIndex}
                        className="grid grid-cols-12 gap-2 items-center px-3 py-2 rounded-xl bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 transition"
                      >
                        {/* Timestamp Button */}
                        <div className="col-span-3 sm:col-span-2">
                          <button
                            type="button"
                            onClick={() => handleSeekVideo(ch.startTimeSeconds)}
                            title="Click to jump video to this timestamp"
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-950/60 hover:bg-indigo-900 text-indigo-300 font-mono text-xs font-bold border border-indigo-800/50 transition cursor-pointer"
                          >
                            <span>▶</span>
                            <span>{ch.timestamp}</span>
                          </button>
                        </div>

                        {/* Beat Number */}
                        <div className="col-span-2 sm:col-span-2 text-xs text-zinc-400 font-medium">
                          Beat {ch.beatIndex + 1}
                        </div>

                        {/* Editable Title Input */}
                        <div className="col-span-5 sm:col-span-6">
                          <input
                            type="text"
                            value={currentTitle}
                            onChange={(e) =>
                              setEditingTitles((prev) => ({
                                ...prev,
                                [ch.beatIndex]: e.target.value,
                              }))
                            }
                            className="w-full bg-zinc-950/80 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                            placeholder={`Chapter ${ch.beatIndex + 1} Title`}
                          />
                        </div>

                        {/* Duration */}
                        <div className="col-span-2 text-right text-xs font-mono text-zinc-400">
                          {(ch.durationMs / 1000).toFixed(1)}s
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Bottom Bar: Total & Save */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-zinc-800/80 text-xs text-zinc-400">
                <div className="flex items-center gap-4">
                  <span>
                    Total Duration:{' '}
                    <strong className="text-zinc-200 font-mono">
                      {chaptersData.totalDurationFormatted}
                    </strong>
                  </span>
                  <span>•</span>
                  <span>
                    Chapters Count:{' '}
                    <strong className="text-zinc-200 font-mono">
                      {chaptersData.chapters.length}
                    </strong>
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {saveSuccess && (
                    <span className="text-emerald-400 font-medium text-xs flex items-center gap-1">
                      <span>✓</span> Saved successfully
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={handleSaveChapters}
                    disabled={isSavingTitles}
                    className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 disabled:opacity-50 transition"
                  >
                    {isSavingTitles ? 'Saving...' : 'Save Chapter Titles'}
                  </button>
                </div>
              </div>

              {/* Raw YouTube Snippet Box */}
              <div className="space-y-1.5 pt-2">
                <div className="flex items-center justify-between text-[11px] text-zinc-400">
                  <span className="font-semibold uppercase tracking-wider">
                    Raw YouTube Description Snippet
                  </span>
                </div>
                <pre className="p-3 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-mono text-zinc-300 whitespace-pre-wrap select-all">
                  {chaptersData.formattedText}
                </pre>
              </div>

              {/* Credits the licences require in the description */}
              {chaptersData.creditsText && (
                <div className="space-y-1.5 pt-2">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span className="font-semibold uppercase tracking-wider">Description Credits (required by the licences)</span>
                    <button
                      type="button"
                      onClick={handleCopyCredits}
                      className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[11px] font-medium transition"
                    >
                      {copiedCredits ? '✓ Copied' : 'Copy credits'}
                    </button>
                  </div>
                  <pre className="p-3 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-mono text-zinc-300 whitespace-pre-wrap select-all">
                    {chaptersData.creditsText}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Final quality check on the rendered video */}
        {qualityReport && qualityReport.checks.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Final Quality Check</h2>
              <span
                className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${
                  qualityReport.passed
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                    : 'bg-red-950 text-red-300 border-red-800'
                }`}
              >
                {qualityReport.passed ? '✓ Ready to upload' : '✗ Needs attention'}
              </span>
            </div>
            <ul className="divide-y divide-zinc-800/80">
              {qualityReport.checks.map((c) => (
                <li key={c.id} className="flex items-start gap-3 py-2 text-sm">
                  <span className={c.status === 'pass' ? 'text-emerald-400' : c.status === 'warn' ? 'text-amber-400' : 'text-red-400'}>
                    {c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✗'}
                  </span>
                  <span className="text-zinc-200 font-medium min-w-[14rem]">{c.label}</span>
                  <span className="text-zinc-400 text-xs pt-0.5">{c.detail}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-zinc-500">
              Checked {new Date(qualityReport.checkedAt).toLocaleString()}. Intended dips at chapter changes and the closing fade are not flagged.
            </p>
          </div>
        )}

        {/* Pipeline Stages Progress */}
        {job && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Pipeline Stages</h2>
              <span className="text-xs text-zinc-400 font-mono">Job ID: {job.id}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {(job.stages && job.stages.length > 0
                ? job.stages
                : ['research', 'script', 'tts', 'assembly']
              ).map((stageName) => {
                const stageRow = stages.find((s) => s.stage === stageName);
                const stageStatus = stageRow?.status || 'pending';

                return (
                  <div
                    key={stageName}
                    className={`p-4 rounded-xl border flex flex-col justify-between gap-3 ${
                      stageStatus === 'done'
                        ? 'bg-emerald-950/20 border-emerald-800/60'
                        : stageStatus === 'running'
                        ? 'bg-blue-950/20 border-blue-600'
                        : stageStatus === 'failed'
                        ? 'bg-rose-950/20 border-rose-800'
                        : 'bg-zinc-950 border-zinc-800 opacity-70'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sm capitalize text-zinc-200">
                        {stageName}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded font-mono ${
                          stageStatus === 'done'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : stageStatus === 'running'
                            ? 'bg-blue-500/10 text-blue-400 animate-pulse'
                            : stageStatus === 'failed'
                            ? 'bg-rose-500/10 text-rose-400'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {stageStatus}
                      </span>
                    </div>

                    {stageRow?.error && (
                      <p className="text-xs text-rose-400 line-clamp-2">
                        {stageRow.error}
                      </p>
                    )}

                    {stageRow?.started_at && (
                      <span className="text-[11px] text-zinc-500">
                        Started: {new Date(stageRow.started_at).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Scene Units Fine-Grained Checkpoints */}
        {units.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-white">Scene Checkpoints</h2>
                <p className="text-xs text-zinc-400">
                  Completed {completedUnits} of {totalUnits} unit tasks
                  {totalCost > 0 && ` • Estimated Cost: $${totalCost.toFixed(4)}`}
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                {/* Filter Tabs */}
                <div className="flex items-center gap-1.5 bg-zinc-950 p-1 rounded-xl border border-zinc-800 text-xs">
                  <button
                    onClick={() => setStageFilter('all')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition ${
                      stageFilter === 'all'
                        ? 'bg-zinc-800 text-white shadow'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    All ({totalUnits})
                  </button>
                  {visualsUnitsCount > 0 && (
                    <button
                      onClick={() => setStageFilter('visuals')}
                      className={`px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 ${
                        stageFilter === 'visuals'
                          ? 'bg-emerald-600 text-white shadow'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      <span>Visuals</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-950/80 border border-emerald-500/30">
                        {visualsUnitsCount}
                      </span>
                    </button>
                  )}
                  {ttsUnitsCount > 0 && (
                    <button
                      onClick={() => setStageFilter('tts')}
                      className={`px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 ${
                        stageFilter === 'tts'
                          ? 'bg-blue-600 text-white shadow'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      <span>TTS</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-blue-950/80 border border-blue-500/30">
                        {ttsUnitsCount}
                      </span>
                    </button>
                  )}
                </div>

                <div className="w-full sm:w-36 bg-zinc-800 h-2.5 rounded-full overflow-hidden shrink-0">
                  <div
                    className="bg-emerald-500 h-full transition-all duration-500"
                    style={{
                      width: `${totalUnits > 0 ? (completedUnits / totalUnits) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {filteredUnits.map((unit) => {
                const asset =
                  unit.stage === 'visuals'
                    ? assets.find((a) => a.beat_index === unit.unit_index)
                    : null;
                const visualType =
                  asset?.visual_type ||
                  (unit.output_path?.endsWith('.png') ? 'chart' : 'stock');

                if (unit.stage === 'visuals') {
                  return (
                    <div
                      key={unit.id}
                      className="p-5 rounded-xl bg-zinc-950 border border-zinc-800/90 hover:border-zinc-700/80 transition space-y-4"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-700 flex items-center justify-center text-xs font-mono font-bold text-zinc-300 shrink-0">
                            #{unit.unit_index}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                                {unit.stage}
                              </span>
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                                  unit.status === 'done'
                                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                    : unit.status === 'running'
                                    ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse'
                                    : unit.status === 'failed'
                                    ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                                    : 'bg-zinc-800 text-zinc-400'
                                }`}
                              >
                                {unit.status}
                              </span>
                            </div>
                            {unit.output_path && (
                              <p
                                className="text-xs text-zinc-500 font-mono truncate max-w-xs sm:max-w-md mt-0.5"
                                title={unit.output_path}
                              >
                                {unit.output_path}
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-3 text-xs text-zinc-400 font-mono self-end sm:self-center">
                          {unit.duration_ms != null && unit.duration_ms > 0 && (
                            <span className="bg-zinc-900 px-2.5 py-1 rounded border border-zinc-800 text-zinc-300">
                              {(unit.duration_ms / 1000).toFixed(1)}s
                            </span>
                          )}
                          {unit.cost_usd != null && (
                            <span>${Number(unit.cost_usd).toFixed(4)}</span>
                          )}
                          {unit.attempts > 1 && (
                            <span className="text-amber-400">{unit.attempts} attempts</span>
                          )}
                        </div>
                      </div>

                      {job && unit.status === 'done' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start pt-2 border-t border-zinc-900">
                          {/* Visual Media Preview */}
                          <div className="space-y-2">
                            {visualType === 'chart' ? (
                              <div className="rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900 flex items-center justify-center aspect-video">
                                <img
                                  src={`/api/jobs/${job.id}/units/${unit.unit_index}/visual`}
                                  alt={`Beat ${unit.unit_index} chart`}
                                  className="w-full h-full object-contain"
                                  loading="lazy"
                                />
                              </div>
                            ) : (
                              <div className="rounded-xl overflow-hidden border border-zinc-800 bg-black aspect-video flex items-center justify-center">
                                <video
                                  controls
                                  preload="metadata"
                                  className="w-full h-full object-contain"
                                  src={`/api/jobs/${job.id}/units/${unit.unit_index}/visual`}
                                />
                              </div>
                            )}
                          </div>

                          {/* Provenance Fields */}
                          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-4 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                                Provenance & License
                              </span>
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                {asset?.visual_type || visualType}
                              </span>
                            </div>

                            {asset ? (
                              <div className="space-y-2.5 text-xs text-zinc-300">
                                {asset.license_source && (
                                  <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 pb-2">
                                    <span className="text-zinc-400 text-xs">Source Provider:</span>
                                    <span className="font-medium text-white capitalize bg-zinc-800 px-2 py-0.5 rounded border border-zinc-700/60 font-mono text-[11px]">
                                      {asset.license_source}
                                    </span>
                                  </div>
                                )}

                                {asset.source_url && (
                                  <div className="space-y-1 border-b border-zinc-800/60 pb-2">
                                    <span className="text-zinc-400 text-xs">Original Media URL:</span>
                                    <div>
                                      <a
                                        href={asset.source_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sky-400 hover:text-sky-300 hover:underline inline-flex items-center gap-1.5 break-all text-[11px] font-mono"
                                        title={asset.source_url}
                                      >
                                        <span className="line-clamp-1">{asset.source_url}</span>
                                        <span className="shrink-0 text-xs">↗</span>
                                      </a>
                                    </div>
                                  </div>
                                )}

                                {asset.license_type && (
                                  <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 pb-2">
                                    <span className="text-zinc-400 text-xs">License:</span>
                                    <span className="text-zinc-200 text-[11px]">
                                      {asset.license_type}
                                    </span>
                                  </div>
                                )}

                                {asset.attribution_text && (
                                  <div className="space-y-1">
                                    <span className="text-zinc-400 text-xs">Attribution:</span>
                                    <p
                                      className="text-[11px] text-zinc-300 bg-zinc-950/70 p-2.5 rounded-lg border border-zinc-800/80 font-mono break-words"
                                      title={asset.attribution_text}
                                    >
                                      {asset.attribution_text}
                                    </p>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <p className="text-xs text-zinc-500 italic py-2">
                                No provenance record registered in video_assets.
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <div
                    key={unit.id}
                    className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 flex flex-col md:flex-row md:items-center justify-between gap-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-700 flex items-center justify-center text-xs font-mono font-bold text-zinc-300 shrink-0">
                        #{unit.unit_index}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold uppercase text-zinc-300">
                            {unit.stage}
                          </span>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                              unit.status === 'done'
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : unit.status === 'running'
                                ? 'bg-blue-500/10 text-blue-400 animate-pulse'
                                : unit.status === 'failed'
                                ? 'bg-rose-500/10 text-rose-400'
                                : 'bg-zinc-800 text-zinc-400'
                            }`}
                          >
                            {unit.status}
                          </span>
                        </div>
                        {unit.output_path && (
                          <p className="text-xs text-zinc-500 font-mono truncate max-w-xs sm:max-w-md mt-0.5">
                            {unit.output_path}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 self-end md:self-center">
                      {job && unit.status === 'done' && unit.stage === 'tts' && (
                        <audio
                          controls
                          preload="none"
                          className="h-8 max-w-[240px] sm:max-w-[280px]"
                          src={`/api/jobs/${job.id}/units/${unit.unit_index}/audio`}
                        />
                      )}

                      <div className="flex items-center gap-4 text-xs text-zinc-400 font-mono">
                        {unit.duration_ms != null && unit.duration_ms > 0 && (
                          <span>{(unit.duration_ms / 1000).toFixed(1)}s</span>
                        )}
                        {unit.cost_usd != null && (
                          <span>${Number(unit.cost_usd).toFixed(4)}</span>
                        )}
                        {unit.attempts > 1 && (
                          <span className="text-amber-400">{unit.attempts} attempts</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
