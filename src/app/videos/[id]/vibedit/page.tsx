'use client';

import React, { useEffect, useState, useRef, use } from 'react';
import Link from 'next/link';
import type { MediaCandidate } from '@/pipeline/visuals/types';
import { ChatPanel } from './chat-panel';
import { SHORTCUTS, useStableCallback, useVibeditShortcuts } from './shortcuts';
import { BeatPreviewButton } from './beat-preview';
import { CaptionEditor } from './caption-editor';
import { BulkFixes } from './bulk-fixes';
import { VersionsPanel } from './versions-panel';
import { AlternativeCard } from '../visuals/alternative-card';
import { ShotEditor } from '../visuals/shot-editor';
import { ReviewNotes } from './review-notes';

interface VibeditPageProps {
  params: Promise<{ id: string }>;
}

interface ScriptBeat {
  text: string;
  visual_query?: string;
  visual_type?: string;
  duration_estimate_seconds?: number;
}

interface VideoAsset {
  id: string;
  video_id: string;
  beat_index: number;
  visual_type: string;
  source_url: string | null;
  license_type: string | null;
  license_source: string | null;
  attribution_text: string | null;
  start_offset_seconds?: number | null;
  candidates_json?: MediaCandidate[] | null;
}

interface JobUnit {
  stage: string;
  unit_index: number;
  status: string;
  duration_ms: number | null;
  output_path?: string | null;
}

interface VideoProgressData {
  video: {
    id: string;
    title: string | null;
    status: string;
    script_json?: {
      beats?: ScriptBeat[];
      still_motion?: 'zoom' | 'static';
      preview?: { renderedAt: string | null; error: string | null; only?: number[] };
    } | null;
  };
  job: {
    id: string;
    status?: string;
  } | null;
  units: JobUnit[];
  assets: VideoAsset[];
}

export default function VibeditStudioPage({ params }: VibeditPageProps) {
  const resolvedParams = use(params);
  const id = resolvedParams.id;

  const [data, setData] = useState<VideoProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cacheBuster, setCacheBuster] = useState(Date.now());

  // Video Player state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [, setVideoDuration] = useState(0);
  const [activeBeatIndex, setActiveBeatIndex] = useState(0);
  const [videoLoadError, setVideoLoadError] = useState(false);

  // Monitor view mode: 'master' (full rendered video) vs 'beat' (isolated beat asset)
  const [playerMode, setPlayerMode] = useState<'master' | 'beat'>('master');

  // Per-beat editing states
  const [editedTexts, setEditedTexts] = useState<Record<number, string>>({});
  const [regeningBeat, setRegeningBeat] = useState<number | null>(null);
  const [swappingBeat, setSwappingBeat] = useState<number | null>(null);
  const [searchQueries, setSearchQueries] = useState<Record<number, string>>({});
  const [searchingBeat, setSearchingBeat] = useState<number | null>(null);
  const [generatingAiBeat, setGeneratingAiBeat] = useState<number | null>(null);
  const [generatingVideoBeat, setGeneratingVideoBeat] = useState<number | null>(null);
  const [uploadingBeat, setUploadingBeat] = useState<number | null>(null);
  const [keyModalMessage, setKeyModalMessage] = useState<string | null>(null);
  const [customCandidates, setCustomCandidates] = useState<Record<number, MediaCandidate[]>>({});


  // Assembly trigger
  const [isAssembling, setIsAssembling] = useState(false);
  const [assemblyMsg, setAssemblyMsg] = useState<string | null>(null);

  const [beatMediaType, setBeatMediaType] = useState<'video' | 'image'>('video');


  useEffect(() => {
    // Started from a microtask: fetchVideoData sets state only once its request answers
    void Promise.resolve().then(() => fetchVideoData());
  }, [id]);

  useEffect(() => {
    // Clearing the error before the HEAD check is deliberate; deferring it would show a stale error for a frame.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVideoLoadError(false);
    if (playerMode === 'beat') {
      fetch(`/api/videos/${id}/beats/${activeBeatIndex}/visual?t=${cacheBuster}`, {
        method: 'HEAD',
      })
        .then((res) => {
          if (!res.ok) {
            setVideoLoadError(true);
            return;
          }
          const ct = res.headers.get('content-type') || '';
          if (ct.startsWith('image/')) {
            setBeatMediaType('image');
          } else {
            setBeatMediaType('video');
          }
        })
        .catch(() => {
          setBeatMediaType('video');
        });
    } else {
      setBeatMediaType('video');
    }
  }, [playerMode, activeBeatIndex, cacheBuster, id]);


  // Auto-poll progress if video is currently rendering or assembling
  const isVideoRendering =
    data?.video?.status === 'rendering' ||
    data?.video?.status === 'assembling';

  useEffect(() => {
    if (isVideoRendering) {
      const interval = setInterval(() => {
        fetchVideoData();
      }, 2500);
      return () => clearInterval(interval);
    }
  }, [isVideoRendering]);

  async function fetchVideoData() {
    try {
      const res = await fetch(`/api/videos/${id}/progress`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData((prev) => {
        const prevStatus = prev?.video?.status;
        const nextStatus = json.video?.status;
        if (
          (nextStatus === 'rendered' || nextStatus === 'ready') &&
          (prevStatus === 'rendering' || prevStatus === 'assembling')
        ) {
          setCacheBuster(Date.now());
          setPlayerMode('master');
          setAssemblyMsg('🎉 Master video render complete! Ready to view.');
        }
        return json;
      });

      // Populate text edits
      const beats: ScriptBeat[] = json.video?.script_json?.beats || [];
      const texts: Record<number, string> = {};
      beats.forEach((b, i) => {
        texts[i] = b.text;
      });
      setEditedTexts(texts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // Calculate cumulative time boundaries for each beat
  const beats: ScriptBeat[] = data?.video?.script_json?.beats || [];
  const ttsUnits = data?.units?.filter((u) => u.stage === 'tts') || [];
  const assets = data?.assets || [];
  const assetMap = new Map(assets.map((a) => [a.beat_index, a]));

  const beatTimings = beats.map((b, i) => {
    const tts = ttsUnits.find((u) => u.unit_index === i);
    const durSec = tts?.duration_ms ? tts.duration_ms / 1000 : b.duration_estimate_seconds || 4;
    return { index: i, durSec };
  });

  let cumulative = 0;
  const beatTimeRanges = beatTimings.map((bt) => {
    const start = cumulative;
    cumulative += bt.durSec;
    return { ...bt, start, end: cumulative };
  });
  const totalCalculatedDuration = cumulative;

  // Track active beat from video player currentTime
  function handleTimeUpdate() {
    if (!videoRef.current) return;
    const curr = videoRef.current.currentTime;
    setCurrentTime(curr);

    if (playerMode === 'master') {
      const active = beatTimeRanges.find((r) => curr >= r.start && curr < r.end);
      if (active && active.index !== activeBeatIndex) {
        setActiveBeatIndex(active.index);
      }
    }
  }

  function handleJumpToBeat(index: number) {
    setActiveBeatIndex(index);
    const range = beatTimeRanges[index];
    if (playerMode === 'master' && range && videoRef.current) {
      videoRef.current.currentTime = range.start;
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  }

  const [showShortcuts, setShowShortcuts] = useState(false);
  // After a chat edit or bulk fix: fresh thumbnails and data (stable, for the bulk poller's effect)
  const refreshAfterEdit = useStableCallback(() => {
    setCacheBuster(Date.now());
    fetchVideoData();
  });
  useVibeditShortcuts({
    video: () => videoRef.current,
    beatCount: beats.length,
    activeBeat: activeBeatIndex,
    jumpToBeat: handleJumpToBeat,
    toggleMode: () => setPlayerMode((m) => (m === 'master' ? 'beat' : 'master')),
    toggleHelp: () => setShowShortcuts((s) => !s),
  });


  async function handleRegenTts(index: number) {
    const text = editedTexts[index]?.trim();
    if (!text) return;

    try {
      setRegeningBeat(index);
      const res = await fetch(`/api/videos/${id}/beats/${index}/regen-tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to regenerate voice');
      }
      setCacheBuster(Date.now());
      await fetchVideoData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Regeneration failed');
    } finally {
      setRegeningBeat(null);
    }
  }

  async function handleSwapCandidate(index: number, candidate: MediaCandidate) {
    try {
      setSwappingBeat(index);
      const res = await fetch(`/api/videos/${id}/beats/${index}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to swap media');
      }
      setActiveBeatIndex(index);
      setPlayerMode('beat');
      const now = Date.now();
      setCacheBuster(now);
      await fetchVideoData();
      setAssemblyMsg(`✓ Swapped candidate for Beat #${index + 1}! Click "Re-assemble Master Video" to compile it into the final timeline.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Swap failed');
    } finally {
      setSwappingBeat(null);
    }
  }

  async function handleSearch(index: number) {
    const q = searchQueries[index]?.trim();
    if (!q) return;

    try {
      setSearchingBeat(index);
      const res = await fetch(`/api/videos/${id}/beats/${index}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const json = await res.json();
      if (json.candidates) {
        setCustomCandidates((prev) => ({ ...prev, [index]: json.candidates }));
      }
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setSearchingBeat(null);
    }
  }

  async function handleGenerateAi(index: number) {
    try {
      setGeneratingAiBeat(index);
      const customPrompt = searchQueries[index]?.trim() || undefined;
      const res = await fetch(`/api/videos/${id}/beats/${index}/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: customPrompt }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to generate AI visual');
      }
      setActiveBeatIndex(index);
      setPlayerMode('beat');
      setCacheBuster(Date.now());
      await fetchVideoData();
      setAssemblyMsg(`✓ Generated AI visual for Beat #${index + 1}! Click "Re-assemble Master Video" to apply.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'AI visual generation failed');
    } finally {
      setGeneratingAiBeat(null);
    }
  }

  async function handleGenerateVideo(index: number, model: string = 'veo2') {
    try {
      setGeneratingVideoBeat(index);
      const customPrompt = searchQueries[index]?.trim() || undefined;
      const res = await fetch(`/api/videos/${id}/beats/${index}/generate-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: customPrompt, model }),
      });
      const resJson = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (resJson.requiresKey) {
          setKeyModalMessage(resJson.error);
          return;
        }
        throw new Error(resJson.error || 'Failed to generate AI video');
      }
      setActiveBeatIndex(index);
      setPlayerMode('beat');
      setCacheBuster(Date.now());
      await fetchVideoData();
      setAssemblyMsg(`✓ Generated AI video for Beat #${index + 1}! Click "Re-assemble Master Video" to apply.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'AI video generation failed');
    } finally {
      setGeneratingVideoBeat(null);
    }
  }

  async function handleUploadBeatMedia(index: number, file: File) {
    try {
      setUploadingBeat(index);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('license_type', 'own_work');
      formData.append('source_note', `Manual upload: ${file.name}`);

      const res = await fetch(`/api/videos/${id}/beats/${index}/visual`, {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `Upload failed (HTTP ${res.status})`);
      }

      setActiveBeatIndex(index);
      setPlayerMode('beat');
      const now = Date.now();
      setCacheBuster(now);
      await fetchVideoData();
      setAssemblyMsg(`✓ Uploaded "${file.name}" for Beat #${index + 1}! Click "Re-assemble Master Video" to compile it into the final video.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Media upload failed');
    } finally {
      setUploadingBeat(null);
    }
  }

  async function handleStartAssembly() {
    try {
      setIsAssembling(true);
      setAssemblyMsg('Queuing assembly pipeline job...');
      const res = await fetch(`/api/videos/${id}/assembly`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const resJson = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(resJson.error || 'Assembly trigger failed');
      }
      setAssemblyMsg('Rendering master video in background... The player will update automatically when ready.');
      await fetchVideoData();
    } catch (err) {
      setAssemblyMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsAssembling(false);
    }
  }

  async function handleToggleStillMotion(nextMotion: 'zoom' | 'static') {
    try {
      await fetch(`/api/videos/${id}/bgm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stillMotion: nextMotion }),
      });
      await fetchVideoData();
      setAssemblyMsg(
        `Still photos set to "${nextMotion === 'zoom' ? 'Ken Burns Zoom' : 'Static Frame (no motion)'}". Click "Re-assemble Master Video" to apply.`,
      );
    } catch (err) {
      console.warn('Failed to update still motion:', err);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="flex items-center gap-3 text-indigo-400">
          <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <span>Loading Vibedit Studio...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-black text-white p-8">
        <div className="max-w-xl mx-auto p-6 bg-red-950/40 border border-red-800 rounded-xl">
          <h2 className="text-lg font-bold text-red-200">Error Loading Studio</h2>
          <p className="text-sm text-red-300 mt-2">{error || 'Video not found'}</p>
        </div>
      </div>
    );
  }

  const isRendering =
    data.video.status === 'rendering' || data.video.status === 'assembling';
  const stillMotion =
    (data.video.script_json?.still_motion || 'zoom') as 'zoom' | 'static';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      {showShortcuts && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowShortcuts(false)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-5 w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white">⌨️ Keyboard shortcuts</h2>
              <button onClick={() => setShowShortcuts(false)} className="text-zinc-400 hover:text-white text-sm">✕</button>
            </div>
            <table className="w-full text-xs">
              <tbody>
                {SHORTCUTS.map((s) => (
                  <tr key={s.keys} className="border-t border-zinc-800">
                    <td className="py-1.5 pr-3 font-mono text-indigo-300 whitespace-nowrap">{s.keys}</td>
                    <td className="py-1.5 text-zinc-300">{s.does}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-zinc-500">They don&apos;t fire while you type in a box.</p>
          </div>
        </div>
      )}

      {/* Top Navigation Bar */}
      <header className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur sticky top-0 z-50 px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/videos"
            className="text-xs font-semibold text-zinc-400 hover:text-white transition flex items-center gap-1.5"
          >
            <span>←</span> Back to Dashboard
          </Link>
          <span className="text-zinc-600">/</span>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 text-[11px] font-bold uppercase tracking-wider">
              Vibedit Studio
            </span>
            <h1 className="text-sm font-bold text-white truncate max-w-sm">
              {data.video.title || 'Untitled Production'}
            </h1>
            {isRendering && (
              <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold animate-pulse flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
                Rendering Master...
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowShortcuts((s) => !s)}
            title="Keyboard shortcuts (?)"
            className="px-2 py-1 rounded-lg bg-zinc-950/80 border border-zinc-800 text-[11px] text-zinc-400 hover:text-zinc-100"
          >
            ⌨️ Shortcuts
          </button>
          {/* Still Image Motion Mode */}
          <div className="flex items-center gap-1 bg-zinc-950/80 border border-zinc-800 rounded-lg p-0.5" title="Still photo motion: Static keeps photos stationary, Zoom applies Ken Burns slow zoom">
            <span className="text-[10px] text-zinc-400 font-medium px-2">Photos:</span>
            <button
              type="button"
              onClick={() => handleToggleStillMotion('static')}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition cursor-pointer flex items-center gap-1 ${
                stillMotion === 'static'
                  ? 'bg-zinc-700 text-white shadow'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Static: Still images stay completely locked (only video clips move)"
            >
              <span>⏹</span> Static
            </button>
            <button
              type="button"
              onClick={() => handleToggleStillMotion('zoom')}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition cursor-pointer flex items-center gap-1 ${
                stillMotion === 'zoom'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Zoom: Subtle cinematic slow zoom on still photos"
            >
              <span>🎬</span> Zoom
            </button>
          </div>

          <Link
            href={`/videos/${id}/visuals`}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-300 transition"
          >
            Visuals Studio
          </Link>
          <Link
            href={`/videos/${id}/progress`}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-300 transition"
          >
            Pipeline Progress
          </Link>
          <button
            onClick={handleStartAssembly}
            disabled={isAssembling || isRendering}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition shadow-lg flex items-center gap-1.5 cursor-pointer ${
              isRendering
                ? 'bg-amber-600/60 text-white cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-950'
            }`}
          >
            <span>🚀</span>
            <span>
              {isAssembling
                ? 'Queuing...'
                : isRendering
                ? 'Rendering Master...'
                : 'Re-assemble Master Video'}
            </span>
          </button>
        </div>
      </header>

      {/* Assembly Feedback Banner */}
      {assemblyMsg && (
        <div className="bg-indigo-950/60 border-b border-indigo-800/60 px-6 py-2.5 flex items-center justify-between text-xs text-indigo-200">
          <div className="flex items-center gap-2">
            <span>ℹ️</span>
            <span>{assemblyMsg}</span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href={`/videos/${id}/progress`}
              className="text-indigo-400 hover:text-white underline font-semibold"
            >
              View Progress →
            </Link>
            <button
              onClick={() => setAssemblyMsg(null)}
              className="text-zinc-400 hover:text-white cursor-pointer ml-2"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Main Split-Screen Layout */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left Column: Synchronized Playback Monitor & Beat Scrubber */}
        <div className="w-full lg:w-1/2 p-6 flex flex-col gap-4 border-b lg:border-b-0 lg:border-r border-zinc-800 bg-zinc-950/60 overflow-y-auto">
          {/* Monitor Mode Selector */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 bg-zinc-900 p-1 rounded-xl border border-zinc-800">
              <button
                onClick={() => setPlayerMode('master')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
                  playerMode === 'master'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <span>🎬</span> Master Video (Full Edit)
              </button>
              <button
                onClick={() => setPlayerMode('beat')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
                  playerMode === 'beat'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <span>🖼️</span> Isolated Beat #{activeBeatIndex + 1}
              </button>
            </div>

            <span className="text-[11px] text-zinc-500 font-medium">
              {playerMode === 'master' ? 'Playing master timeline' : 'Previewing isolated asset'}
            </span>
          </div>

          {/* Video Player Card */}
          <div className="relative aspect-video w-full bg-black rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl flex items-center justify-center">
            {videoLoadError ? (
              <div className="flex flex-col items-center justify-center p-6 text-center space-y-3 bg-zinc-950/90 z-10 w-full h-full">
                <span className="text-3xl">🎬</span>
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-white">
                    {playerMode === 'master'
                      ? 'Master Video Not Assembled Yet'
                      : `Isolated Beat #${activeBeatIndex + 1} Visual Not Found`}
                  </h3>
                  <p className="text-xs text-zinc-400 max-w-sm">
                    {playerMode === 'master'
                      ? 'The full timeline needs to be rendered before it can be played back as a single master video.'
                      : 'This beat does not have an active video or image file on disk yet. Select a footage candidate or generate an AI visual.'}
                  </p>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  {playerMode === 'master' ? (
                    <>
                      <button
                        type="button"
                        onClick={handleStartAssembly}
                        disabled={isAssembling || isRendering}
                        className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white transition shadow cursor-pointer"
                      >
                        🚀 Assemble Master Video
                      </button>
                      <button
                        type="button"
                        onClick={() => setPlayerMode('beat')}
                        className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-300 transition cursor-pointer"
                      >
                        Preview Isolated Beats
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPlayerMode('master')}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white transition cursor-pointer"
                    >
                      Back to Master Monitor
                    </button>
                  )}
                </div>
              </div>
            ) : playerMode === 'beat' && beatMediaType === 'image' ? (
              <div className="w-full h-full flex items-center justify-center bg-black relative">
                <img
                  key={`beat-img-${activeBeatIndex}-${cacheBuster}`}
                  src={`/api/videos/${id}/beats/${activeBeatIndex}/visual?t=${cacheBuster}`}
                  alt={`Beat #${activeBeatIndex + 1}`}
                  onError={() => setVideoLoadError(true)}
                  className="w-full h-full object-contain"
                />
              </div>
            ) : (
              <video
                key={playerMode === 'master' ? `master-${cacheBuster}` : `beat-${activeBeatIndex}-${cacheBuster}`}
                ref={videoRef}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onError={() => setVideoLoadError(true)}
                controls
                className="w-full h-full object-contain"
                src={
                  playerMode === 'master'
                    ? `/api/videos/${id}/render?t=${cacheBuster}`
                    : `/api/videos/${id}/beats/${activeBeatIndex}/visual?t=${cacheBuster}`
                }
              />
            )}

            <div className="absolute top-3 left-3 px-3 py-1 rounded-full bg-black/80 backdrop-blur border border-zinc-700/80 text-[11px] font-mono font-bold text-indigo-300">
              {playerMode === 'master'
                ? `Master Timeline: Beat #${activeBeatIndex + 1}`
                : `Isolated Preview: Beat #${activeBeatIndex + 1}`}
            </div>
          </div>


          {/* Interactive Beat Timeline Scrubber */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-zinc-300 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <span>⏱️</span> Interactive Storyboard Scrubber
              </span>
              <span className="font-mono text-indigo-400 font-bold">
                {currentTime.toFixed(1)}s / {totalCalculatedDuration.toFixed(1)}s
              </span>
            </div>

            {/* Segmented Timeline Bar */}
            <div className="w-full h-4 bg-zinc-950 rounded-lg overflow-hidden flex border border-zinc-800 p-0.5 gap-1">
              {beatTimeRanges.map((range) => {
                const widthPct = (range.durSec / totalCalculatedDuration) * 100;
                const isActive = activeBeatIndex === range.index;

                return (
                  <div
                    key={range.index}
                    onClick={() => handleJumpToBeat(range.index)}
                    title={`Jump to Beat #${range.index + 1} (${range.durSec.toFixed(1)}s)`}
                    style={{ width: `${widthPct}%` }}
                    className={`h-full rounded cursor-pointer transition-all ${
                      isActive
                        ? 'bg-indigo-500 shadow-sm shadow-indigo-400'
                        : 'bg-zinc-800 hover:bg-zinc-700'
                    }`}
                  />
                );
              })}
            </div>

            {/* Review notes pinned to moments */}
            <ReviewNotes
              videoId={id}
              currentSec={currentTime}
              totalSec={totalCalculatedDuration}
              activeBeat={activeBeatIndex}
              onSeek={(note) => {
                if (playerMode === 'master' && videoRef.current) {
                  videoRef.current.currentTime = note.atSec;
                  setActiveBeatIndex(note.beat);
                } else {
                  handleJumpToBeat(note.beat);
                }
              }}
            />

            {/* Quick Beat Selector Chips */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 pt-1">
              {beats.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleJumpToBeat(i)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold transition flex-shrink-0 cursor-pointer ${
                    activeBeatIndex === i
                      ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-750 hover:text-zinc-200'
                  }`}
                >
                  #{i + 1}
                </button>
              ))}
            </div>
          </div>

          <ChatPanel
            videoId={id}
            onApplied={refreshAfterEdit}
            onJumpToBeat={handleJumpToBeat}
          />

          <BulkFixes videoId={id} onApplied={refreshAfterEdit} />

          <VersionsPanel videoId={id} onRestored={refreshAfterEdit} onJumpToBeat={handleJumpToBeat} />

          {assemblyMsg && (
            <div className="p-3 bg-red-950/60 border border-red-800 rounded-xl text-xs text-red-200">
              {assemblyMsg}
            </div>
          )}
        </div>

        {/* Right Column: Beat Storyboard Cards Feed */}
        <div className="w-full lg:w-1/2 p-6 overflow-y-auto space-y-6">
          <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
            <div>
              <h2 className="text-base font-bold text-white">Story Feed & Refinement</h2>
              <p className="text-xs text-zinc-400">
                1-click footage swap from archives & instant single-beat voice fixes.
              </p>
            </div>
            <span className="text-xs text-zinc-500 font-mono">
              {beats.length} Total Beats
            </span>
          </div>

          {beats.map((beat, index) => {
            const asset = assetMap.get(index);
            const isActive = activeBeatIndex === index;
            const isRegening = regeningBeat === index;
            const isSwapping = swappingBeat === index;
            const isSearching = searchingBeat === index;
            const pool =
              customCandidates[index] ||
              (Array.isArray(asset?.candidates_json) ? asset.candidates_json : []);

            return (
              <div
                key={index}
                id={`story-beat-${index}`}
                className={`bg-zinc-900 rounded-2xl p-5 border transition-all space-y-4 ${
                  isActive
                    ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-xl shadow-indigo-950/30'
                    : 'border-zinc-800 hover:border-zinc-700'
                }`}
              >
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => handleJumpToBeat(index)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold font-mono transition cursor-pointer ${
                        isActive
                          ? 'bg-indigo-600 text-white'
                          : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                      }`}
                    >
                      ▶ Beat #{index + 1}
                    </button>
                    {asset ? (
                      <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-700/80 flex items-center gap-1">
                        <span>✓</span>
                        <span>{asset.visual_type}</span>
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase font-medium px-2 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-750">
                        No Visual
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {asset && (
                      <BeatPreviewButton
                        videoId={id}
                        beatIndex={index}
                        preview={data.video.script_json?.preview ?? null}
                      />
                    )}
                    <span className="text-xs text-zinc-500 font-mono">
                      {beatTimings[index]?.durSec.toFixed(1)}s
                    </span>
                  </div>
                </div>

                {/* Inline Script Edit & Single-Beat TTS Regen */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                      Narration Voiceover
                    </label>
                    <button
                      type="button"
                      onClick={() => handleRegenTts(index)}
                      disabled={isRegening}
                      className="text-xs font-medium text-indigo-400 hover:text-indigo-300 flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      <span>🎙️</span>
                      <span>{isRegening ? 'Regenerating...' : 'Regen Voice'}</span>
                    </button>
                  </div>

                  <textarea
                    rows={2}
                    value={editedTexts[index] ?? beat.text}
                    onChange={(e) =>
                      setEditedTexts((prev) => ({ ...prev, [index]: e.target.value }))
                    }
                    className="w-full text-xs font-medium leading-relaxed bg-zinc-950/80 border border-zinc-800 rounded-xl p-3 text-zinc-200 focus:outline-none focus:border-indigo-500 transition resize-none"
                  />
                </div>

                {/* Caption editor (the active beat only) */}
                {isActive && (
                  <details className="group rounded-xl border border-zinc-800 bg-zinc-950/40">
                    <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold text-zinc-300">📝 Captions: fix words, highlight, line breaks</summary>
                    <div className="px-3 pb-3">
                      <CaptionEditor key={index} videoId={id} beatIndex={index} />
                    </div>
                  </details>
                )}

                {/* The beat's shots, each with its scored alternatives (composed beats) */}
                {isActive && asset?.visual_type === 'composite' && (
                  <details open className="rounded-xl border border-zinc-800 bg-zinc-950/40">
                    <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold text-zinc-300">🎞️ Shots: swap, search, redo each one</summary>
                    <div className="px-3 pb-3">
                      <ShotEditor key={index} videoId={id} beatIndex={index} onChanged={refreshAfterEdit} />
                    </div>
                  </details>
                )}

                {/* Active Beat Visual Thumbnail Strip */}
                {asset && (() => {
                  const isAssetVideo = /\.(mp4|mov|webm)$/i.test(asset.source_url || '');
                  return (
                    <div className="flex items-center gap-3 p-2.5 rounded-xl bg-zinc-950/70 border border-zinc-800">
                      <div className="relative w-24 aspect-video bg-black rounded-lg overflow-hidden border border-zinc-800 flex-shrink-0 flex items-center justify-center">
                        {isAssetVideo ? (
                          <video
                            src={`/api/videos/${id}/beats/${index}/visual?t=${cacheBuster}`}
                            className="w-full h-full object-cover cursor-pointer"
                            muted
                            playsInline
                            loop
                            onMouseOver={(e) => e.currentTarget.play().catch(() => {})}
                            onMouseOut={(e) => {
                              e.currentTarget.pause();
                              e.currentTarget.currentTime = 0;
                            }}
                          />
                        ) : (
                          <img
                            src={`/api/videos/${id}/beats/${index}/visual?t=${cacheBuster}`}
                            alt={`Beat #${index + 1}`}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.currentTarget as HTMLElement).style.display = 'none';
                            }}
                          />
                        )}
                        <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded text-[8px] font-bold uppercase bg-black/80 text-zinc-300">
                          {isAssetVideo ? 'VIDEO' : 'IMAGE'}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                          <span className="text-emerald-400">✓ Active Visual:</span>
                          <span className="uppercase text-[11px] font-mono text-zinc-300">{asset.visual_type}</span>
                          {asset.license_type && (
                            <span className="text-[10px] text-zinc-400 font-mono">({asset.license_type})</span>
                          )}
                          {isAssetVideo && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-pink-950 text-pink-300 border border-pink-800">
                              MOTION FOOTAGE
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-zinc-400 truncate mt-0.5" title={asset.source_url || ''}>
                          {asset.source_url ? asset.source_url.split(/[/\\]/).pop() : 'Uploaded / assigned media'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveBeatIndex(index);
                          setPlayerMode('beat');
                        }}
                        className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition cursor-pointer flex-shrink-0 flex items-center gap-1 ${
                          isActive && playerMode === 'beat'
                            ? 'bg-indigo-600 border-indigo-500 text-white shadow'
                            : 'bg-zinc-800 hover:bg-zinc-750 border-zinc-700 text-zinc-200'
                        }`}
                      >
                        <span>👁️</span>
                        <span>{isActive && playerMode === 'beat' ? 'Playing' : 'Preview'}</span>
                      </button>
                    </div>
                  );
                })()}

                {/* 1-Click Candidate Swapper Reel */}
                <div className="pt-2 border-t border-zinc-800/80 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-1">
                      <span>🔄</span> Alternative Matches ({pool.length})
                    </span>

                    {/* Quick Search */}
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        placeholder="Search archives, NASA, stock..."
                        value={searchQueries[index] || ''}
                        onChange={(e) =>
                          setSearchQueries((prev) => ({ ...prev, [index]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleSearch(index);
                          }
                        }}
                        className="px-2.5 py-1 text-xs rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 w-44"
                      />
                      <button
                        type="button"
                        onClick={() => handleSearch(index)}
                        disabled={isSearching}
                        className="px-2.5 py-1 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition cursor-pointer"
                      >
                        {isSearching ? '...' : 'Search'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleGenerateAi(index)}
                        disabled={generatingAiBeat === index}
                        className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50 transition cursor-pointer flex items-center gap-1 shadow-sm"
                        title="Synthesize custom AI visual using Flux/Pollinations"
                      >
                        <span>✨</span>
                        <span>{generatingAiBeat === index ? 'Generating...' : 'AI Visual'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleGenerateVideo(index)}
                        disabled={generatingVideoBeat === index}
                        className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-pink-600 hover:bg-pink-500 text-white disabled:opacity-50 transition cursor-pointer flex items-center gap-1 shadow-sm"
                        title="Synthesize real motion video via Google Veo 2 / Kling"
                      >
                        <span>🎬</span>
                        <span>{generatingVideoBeat === index ? 'Generating...' : 'AI Video'}</span>
                      </button>
                      <label
                        className={`px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition cursor-pointer flex items-center gap-1 shadow-sm ${
                          uploadingBeat === index ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                        title="Upload your own footage (MP4/MOV/WEBM) or photo (JPG/PNG/WEBP)"
                      >
                        <input
                          type="file"
                          accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp"
                          className="hidden"
                          disabled={uploadingBeat === index}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleUploadBeatMedia(index, file);
                            e.target.value = '';
                          }}
                        />
                        <span>📁</span>
                        <span>{uploadingBeat === index ? 'Uploading...' : 'Upload'}</span>
                      </label>
                    </div>
                  </div>


                  {pool.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      {pool.map((cand: MediaCandidate, cIdx: number) => {
                        const isCurrent = Boolean(
                          asset?.source_url?.includes(cand.downloadUrl) ||
                            (asset?.attribution_text && cand.attribution && asset.attribution_text === cand.attribution),
                        );
                        return (
                          <AlternativeCard
                            key={cand.id || cIdx}
                            thumbnailUrl={cand.thumbnailUrl}
                            title={cand.title}
                            provider={cand.provider}
                            isVideo={cand.mediaType === 'video'}
                            videoUrl={cand.mediaType === 'video' ? cand.previewUrl || cand.downloadUrl : undefined}
                            pageUrl={cand.pageUrl}
                            license={cand.license}
                            durationSec={cand.duration}
                            current={isCurrent}
                            disabled={isSwapping}
                            onPick={() => handleSwapCandidate(index, cand)}
                            pickLabel={isSwapping ? 'Swapping…' : 'Swap in'}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-500 italic">
                      No candidate options yet. Type a keyword in the box above to find footage.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* AI Video Activation Guide Modal */}
      {keyModalMessage && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <span>🎬</span> Activate AI Video Generation
              </h3>
              <button
                type="button"
                onClick={() => setKeyModalMessage(null)}
                className="text-zinc-400 hover:text-white cursor-pointer"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-zinc-300 leading-relaxed">
              {keyModalMessage}
            </p>

            <div className="space-y-3 pt-1">
              <div>
                <span className="text-[11px] font-semibold text-emerald-400 block mb-1">
                  Option 1: Direct Google Veo API Key (Google AI Studio / Vertex AI)
                </span>
                <div className="bg-black/60 rounded-xl p-2.5 border border-zinc-800 font-mono text-[11px] text-emerald-300 select-all">
                  GOOGLE_VEO_API_KEY=your_google_key_here
                </div>
                <p className="text-[10px] text-zinc-400 mt-1">
                  Works directly with your key from <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" className="text-indigo-400 underline">Google AI Studio</a> (or GEMINI_API_KEY).
                </p>
              </div>

              <div>
                <span className="text-[11px] font-semibold text-pink-400 block mb-1">
                  Option 2: Fal.ai Gateway (Veo 2, Kling, MiniMax)
                </span>
                <div className="bg-black/60 rounded-xl p-2.5 border border-zinc-800 font-mono text-[11px] text-pink-300 select-all">
                  FAL_KEY=your_fal_api_key_here
                </div>
                <p className="text-[10px] text-zinc-400 mt-1">
                  Provides access via <a href="https://fal.ai" target="_blank" rel="noreferrer" className="text-indigo-400 underline">fal.ai</a> for multiple video foundation models.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setKeyModalMessage(null)}
              className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white cursor-pointer transition mt-2"
            >
              Got it!
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
