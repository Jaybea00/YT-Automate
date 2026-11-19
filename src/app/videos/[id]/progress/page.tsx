'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ActionBar } from '@/components/ui/action-bar';
import { PipelineLog, type JobData, type StageData, type UnitData, type VideoAssetData } from './pipeline-log';
import { RenderResults, type PreviewInfo, type LastRender, type QualityReportView } from './render-results';
import { PageContainer } from '@/components/ui/page';
import { Button, ButtonLink, buttonClass } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { statusOf } from '@/components/shell/video-status';
import { useParams } from 'next/navigation';
import type { RenderReport } from '@/pipeline/runner/render-report';

interface VideoData {
  id: string;
  title: string | null;
  topic: string | null;
  status: string;
  render_url: string | null;
  error_message: string | null;
  bgm_track?: string | null;
  script_json?: Record<string, unknown> | null;
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

interface ProgressResponse {
  video: VideoData;
  job: JobData | null;
  stages: StageData[];
  units: UnitData[];
  assets?: VideoAssetData[];
  error?: string;
  /** A running assembly's percentage, step and time left. */
  assemblyProgress?: { percent: number; label: string; detail?: string; etaSec?: number; updatedAt: string; stale?: boolean } | null;
}

/** "1 h 12 min", "38 min", "under a minute". */
function formatEta(sec: number): string {
  if (sec < 60) return 'under a minute';
  const minutes = Math.round(sec / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

export default function PipelineProgressPage() {
  const params = useParams();
  const id = params?.id as string;

  const [data, setData] = useState<ProgressResponse | null>(null);
  const [, setLoading] = useState(true);
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
  // Held for tonight's render queue, and the hours it runs
  const [overnight, setOvernight] = useState<{ queued: boolean; window: { start: string; end: string } } | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch('/api/overnight')
      .then((r) => (r.ok ? r.json() : null))
      .then((q) => {
        if (!cancelled && q) setOvernight({ queued: q.items.some((i: { videoId: string }) => i.videoId === id), window: q.window });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function toggleOvernight() {
    if (!id || !overnight) return;
    try {
      const res = overnight.queued
        ? await fetch(`/api/overnight?videoId=${id}`, { method: 'DELETE' })
        : await fetch('/api/overnight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: id }) });
      const q = await res.json();
      if (!res.ok) throw new Error(q.error || 'Could not change the overnight queue');
      setOvernight({ queued: q.items.some((i: { videoId: string }) => i.videoId === id), window: q.window });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not change the overnight queue');
    }
  }

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
    // Started from a microtask: the loaders set state only once their requests answer
    void Promise.resolve().then(() => {
      fetchProgress();
      fetchChapters();
    });
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
      // Voicing and visuals together, as the review page starts them (the route defaults to voicing only)
      const res = await fetch(`/api/videos/${id}/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stages: ['tts', 'visuals'] }),
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

  async function handleStartAssembly(draft = false) {
    setIsTriggering(true);
    try {
      const res = await fetch(`/api/videos/${id}/assembly`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft ? { draft: true } : {}),
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
  const preview = video?.script_json?.preview as PreviewInfo | undefined;
  const lastRender = video?.script_json?.timeline as LastRender | undefined;
  const qualityReport = video?.script_json?.quality_report as QualityReportView | undefined;
  const renderReport = video?.script_json?.render_report as RenderReport | undefined;
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
    <PageContainer>
        {/* Video Header Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-8 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <Badge tone={statusOf(video?.status).tone} pulse={statusOf(video?.status).busy}>{statusOf(video?.status).label}</Badge>
                {job && (
                  <Badge tone={job.status === 'done' ? 'success' : job.status === 'failed' ? 'danger' : 'neutral'}>Job {job.status}</Badge>
                )}
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-zinc-50">Render</h1>
              <p className="text-zinc-400 text-sm mt-1">Voice, assemble and check the finished video.</p>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="ghost" icon="refresh" onClick={() => fetchProgress()}>
                Refresh
              </Button>
              <button
                onClick={() => handleStartAssembly(true)}
                disabled={isTriggering || isRendering}
                title="A quick, small render to check the edit (cuts instead of transitions, no emphasis effects). The final render reuses its work."
                className={buttonClass('secondary')}
              >
                Quick preview
              </button>
              {overnight && (
                <button
                  onClick={toggleOvernight}
                  disabled={isRendering}
                  title={
                    overnight.queued
                      ? 'Take it out of tonight\'s queue'
                      : `Render it tonight, between ${overnight.window.start} and ${overnight.window.end}, while the laptop is free`
                  }
                  className={buttonClass('secondary', 'md', overnight.queued ? '!border-sky-700 !text-sky-200' : '')}
                >
                  <Icon name="moon" size={16} />
                  {overnight.queued ? `Queued for ${overnight.window.start} · cancel` : 'Render tonight'}
                </button>
              )}
              {video?.status !== 'rendered' && (
                <button
                  onClick={() => handleStartAssembly()}
                  disabled={isTriggering || isRendering}
                  className={buttonClass('primary')}
                >
                  {isTriggering || isRendering ? 'Assembling Video...' : 'Start Assembly'}
                </button>
              )}
              {!job && (
                <button
                  onClick={handleStartVoicing}
                  disabled={isTriggering}
                  className={buttonClass('primary')}
                >
                  {isTriggering ? 'Starting...' : 'Start Voicing Pipeline'}
                </button>
              )}
              {job?.status === 'failed' && (
                <button
                  onClick={handleStartVoicing}
                  disabled={isTriggering}
                  className={buttonClass('danger')}
                >
                  {isTriggering ? 'Retrying...' : 'Retry Job'}
                </button>
              )}
            </div>
          </div>

          {/* Assembly progress: percentage, step and time left (written by the worker as it renders) */}
          {data?.assemblyProgress && job?.status === 'running' && (
            <div className="mt-6 p-4 rounded-xl bg-zinc-950/80 border border-indigo-800/60 space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold text-indigo-200">
                  Assembling · {data.assemblyProgress.percent.toFixed(0)}%
                </span>
                <span className="text-zinc-400 text-xs">
                  {data.assemblyProgress.label}
                  {data.assemblyProgress.detail ? ` · ${data.assemblyProgress.detail}` : ''}
                  {data.assemblyProgress.etaSec !== undefined
                    ? ` · about ${formatEta(data.assemblyProgress.etaSec)} left`
                    : ' · working out the time left…'}
                </span>
              </div>
              <div className="h-2.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                <div className="h-full bg-indigo-500 transition-all duration-700" style={{ width: `${Math.min(100, data.assemblyProgress.percent)}%` }} />
              </div>
              {data.assemblyProgress.stale && (
                <p className="text-xs text-amber-300">
                  No update for over 10 minutes: check the worker is still running (its console shows each step).
                </p>
              )}
            </div>
          )}

          {/* Error Banner */}
          {(video?.error_message || job?.error || error) && (
            <div className="mt-6 p-4 rounded-xl bg-rose-950/40 border border-rose-800 text-rose-300 text-sm">
              <span className="font-semibold">Pipeline Error:</span>{' '}
              {job?.error || video?.error_message || error}
            </div>
          )}

          {/* Rendered Video Player / Output */}
          {(video?.render_url || video?.status === 'rendered') && (
            <div className="mt-6 p-4 sm:p-6 rounded-2xl bg-zinc-950/90 border border-emerald-800/80 shadow-2xl space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Final Video Rendered Successfully</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/videos/${id}/publish`}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition shadow-md shadow-indigo-950"
                  >
                    🚀 Publish: titles, thumbnails, Shorts
                  </Link>
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
            <div className="mt-6 p-4 sm:p-6 rounded-2xl bg-zinc-950/90 border border-zinc-800 shadow-2xl space-y-5">
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
                <pre className="p-3 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-mono text-zinc-300 whitespace-pre-wrap break-all select-all overflow-x-auto">
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
                  <pre className="p-3 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-mono text-zinc-300 whitespace-pre-wrap break-all select-all overflow-x-auto">
                    {chaptersData.creditsText}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        <RenderResults id={id} preview={preview} lastRender={lastRender} qualityReport={qualityReport} renderReport={renderReport} />

        <PipelineLog
          job={job}
          stages={stages}
          units={units}
          assets={assets}
          filteredUnits={filteredUnits}
          stageFilter={stageFilter}
          setStageFilter={setStageFilter}
          completedUnits={completedUnits}
          totalUnits={totalUnits}
          totalCost={totalCost}
          ttsUnitsCount={ttsUnitsCount}
          visualsUnitsCount={visualsUnitsCount}
        />

        {job && (
          <ActionBar
            hint={
              isRendering
                ? 'Rendering now. You can leave this page; the render keeps going.'
                : video?.status === 'rendered'
                  ? 'The video is rendered and checked.'
                  : 'Check the edit with a quick preview, or render the final video.'
            }
          >
            {video?.status === 'rendered' ? (
              <ButtonLink href={`/videos/${id}/publish`} variant="primary" iconRight="chevronRight">
                Go to Publish
              </ButtonLink>
            ) : (
              <>
                <Button onClick={() => handleStartAssembly(true)} disabled={isTriggering || isRendering}>
                  Quick preview
                </Button>
                <Button variant="primary" onClick={() => handleStartAssembly()} disabled={isTriggering || isRendering}>
                  {isTriggering || isRendering ? 'Assembling…' : 'Start assembly'}
                </Button>
              </>
            )}
          </ActionBar>
        )}
    </PageContainer>
  );
}
