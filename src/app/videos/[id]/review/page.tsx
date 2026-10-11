'use client';

import React, { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { VideoRecord } from '@/lib/types/video';
import { ScriptBeat } from '@/lib/script/generate-script';

interface ReviewPageProps {
  params: Promise<{ id: string }>;
}

export default function ScriptReviewPage({ params }: ReviewPageProps) {
  const resolvedParams = use(params);
  const id = resolvedParams.id;
  const router = useRouter();

  const [video, setVideo] = useState<VideoRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Script Review State
  const [selectedTitle, setSelectedTitle] = useState<string>('');
  const [editableBeats, setEditableBeats] = useState<ScriptBeat[]>([]);
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);
  const [isSavingEdits, setIsSavingEdits] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

  // Revision State
  const [feedbackText, setFeedbackText] = useState('');
  const [isRevising, setIsRevising] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);

  // Approval State
  const [isApproving, setIsApproving] = useState(false);
  const [approvalSuccess, setApprovalSuccess] = useState(false);

  // Narrator State
  const [narrators, setNarrators] = useState<Array<{
    id: string;
    voice_id: string;
    name: string;
    sample_url: string | null;
    tier: string | null;
    provider_slug: string | null;
    yt_provider_configs?: { label?: string; provider?: string } | null;
  }>>([]);
  const [styleDefaults, setStyleDefaults] = useState<Record<string, string>>({});
  const [selectedNarratorId, setSelectedNarratorId] = useState<string>('');
  const [isTriggeringVoice, setIsTriggeringVoice] = useState(false);
  const [voiceTriggerError, setVoiceTriggerError] = useState<string | null>(null);

  // Script Import & Enhancement State
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importTab, setImportTab] = useState<'raw' | 'srt'>('raw');
  const [importRawText, setImportRawText] = useState('');
  const [importRawMode, setImportRawMode] = useState<'raw_paragraphs' | 'raw_ai'>('raw_paragraphs');
  const [importSrtText, setImportSrtText] = useState('');
  const [importSmartMerge, setImportSmartMerge] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [isGeneratingHints, setIsGeneratingHints] = useState(false);

  // Fetch Video Data
  async function fetchVideo(quiet = false) {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(`/api/videos/${id}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to load video details.');
      }
      const data: VideoRecord = await res.json();
      setVideo(data);

      if (data.title) {
        setSelectedTitle(data.title);
      } else if (data.script_json?.title_options?.length && !selectedTitle) {
        // Pre-select first title if none selected
        setSelectedTitle(data.script_json.title_options[0]);
      }

      if (data.script_json?.beats) {
        setEditableBeats(data.script_json.beats);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error fetching video');
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  // Fetch Narrators and Style Defaults
  useEffect(() => {
    async function loadNarratorsAndDefaults() {
      try {
        const [narratorsRes, defaultsRes] = await Promise.all([
          fetch('/api/narrators'),
          fetch('/api/narrators/defaults'),
        ]);

        let loadedNarrators: any[] = [];
        if (narratorsRes.ok) {
          loadedNarrators = await narratorsRes.json();
          setNarrators(Array.isArray(loadedNarrators) ? loadedNarrators : []);
        }

        let defaults: Record<string, string> = {};
        if (defaultsRes.ok) {
          const dData = await defaultsRes.json();
          defaults = dData.defaults || {};
          setStyleDefaults(defaults);
        }

        if (video) {
          const defaultNarratorId = defaults[video.style];
          if ((video as any).narrator_id) {
            setSelectedNarratorId((video as any).narrator_id);
          } else if (defaultNarratorId && loadedNarrators.some((n: any) => n.id === defaultNarratorId)) {
            setSelectedNarratorId(defaultNarratorId);
          } else if (loadedNarrators.length > 0 && !selectedNarratorId) {
            setSelectedNarratorId(loadedNarrators[0].id);
          }
        }
      } catch (err) {
        console.error('Failed to load narrators:', err);
      }
    }

    if (video) {
      loadNarratorsAndDefaults();
    }
  }, [video?.id, video?.style, (video as any)?.narrator_id]);

  async function handleStartVoicing() {
    setIsTriggeringVoice(true);
    setVoiceTriggerError(null);
    try {
      const payload: Record<string, unknown> = {
        stages: ['tts', 'visuals'],
      };
      if (selectedNarratorId) {
        payload.narratorId = selectedNarratorId;
      }

      const res = await fetch(`/api/videos/${id}/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start voicing.');
      }

      router.push(`/videos/${id}/progress`);
    } catch (err) {
      setVoiceTriggerError(err instanceof Error ? err.message : 'Error starting voicing.');
    } finally {
      setIsTriggeringVoice(false);
    }
  }

  useEffect(() => {
    fetchVideo();
  }, [id]);

  // Polling when in 'scripting' status
  useEffect(() => {
    if (!video || video.status !== 'scripting') return;

    const interval = setInterval(() => {
      fetchVideo(true);
    }, 3000);

    return () => clearInterval(interval);
  }, [video?.status, id]);

  // Handle Beat Text Edit
  function handleBeatTextChange(index: number, newText: string) {
    setEditableBeats((prev) =>
      prev.map((beat) => (beat.index === index ? { ...beat, text: newText } : beat)),
    );
    setHasUnsavedEdits(true);
    setSaveFeedback(null);
  }

  // Save Inline Beat Edits via PATCH /api/videos/[id]
  async function handleSaveEdits() {
    if (!video || !video.script_json) return;
    setIsSavingEdits(true);
    setSaveFeedback(null);

    const updatedScript = {
      ...video.script_json,
      beats: editableBeats,
    };

    try {
      const res = await fetch(`/api/videos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script_json: updatedScript,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to save changes.');
      }

      const updated: VideoRecord = await res.json();
      setVideo(updated);
      setHasUnsavedEdits(false);
      setSaveFeedback('Beats saved successfully.');
      setTimeout(() => setSaveFeedback(null), 3000);
    } catch (err) {
      setSaveFeedback(
        err instanceof Error ? `Save failed: ${err.message}` : 'Save failed.',
      );
    } finally {
      setIsSavingEdits(false);
    }
  }

  function handleAddBeat(afterIndex?: number) {
    const newBeat: ScriptBeat = {
      index: 0,
      text: 'New narration beat line...',
      visual_type: 'stock',
      visual_query: 'relevant scene footage',
      duration_estimate_seconds: 5,
    };
    setEditableBeats((prev) => {
      const copy = [...prev];
      const insertAt = afterIndex !== undefined ? afterIndex + 1 : copy.length;
      copy.splice(insertAt, 0, newBeat);
      return copy.map((b, idx) => ({ ...b, index: idx }));
    });
    setHasUnsavedEdits(true);
    setSaveFeedback(null);
  }

  function handleDeleteBeat(index: number) {
    if (editableBeats.length <= 1) {
      alert('A script must contain at least 1 beat.');
      return;
    }
    setEditableBeats((prev) => {
      const filtered = prev.filter((_, idx) => idx !== index);
      return filtered.map((b, idx) => ({ ...b, index: idx }));
    });
    setHasUnsavedEdits(true);
    setSaveFeedback(null);
  }

  function handleMoveBeat(index: number, direction: 'up' | 'down') {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= editableBeats.length) return;
    setEditableBeats((prev) => {
      const copy = [...prev];
      const temp = copy[index];
      copy[index] = copy[targetIndex];
      copy[targetIndex] = temp;
      return copy.map((b, idx) => ({ ...b, index: idx }));
    });
    setHasUnsavedEdits(true);
    setSaveFeedback(null);
  }

  async function handleImportScript() {
    setIsImporting(true);
    setImportError(null);
    try {
      const payload: Record<string, any> = {
        mode: importTab === 'srt' ? 'srt' : importRawMode,
      };

      if (importTab === 'srt') {
        if (!importSrtText.trim()) throw new Error('Please provide SRT subtitle content.');
        payload.srtText = importSrtText.trim();
        payload.minBeatDurationSeconds = importSmartMerge ? 4.0 : 0;
      } else {
        if (!importRawText.trim()) throw new Error('Please provide script text.');
        payload.rawText = importRawText.trim();
      }

      const res = await fetch(`/api/videos/${id}/script/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to import script');

      if (json.script?.beats) {
        setEditableBeats(json.script.beats);
      }
      setHasUnsavedEdits(false);
      setIsImportModalOpen(false);
      await fetchVideo(true);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsImporting(false);
    }
  }

  async function handleAutoVisualHints() {
    setIsGeneratingHints(true);
    try {
      const res = await fetch(`/api/videos/${id}/script/visual-queries`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to generate visual hints');
      if (json.beats) {
        setEditableBeats(json.beats);
      }
      setHasUnsavedEdits(false);
      await fetchVideo(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error generating visual hints');
    } finally {
      setIsGeneratingHints(false);
    }
  }

  // Handle Request Changes / Revise via POST /api/videos/[id]/script/revise
  async function handleRevise(e: React.FormEvent) {
    e.preventDefault();
    if (!feedbackText.trim()) return;

    setIsRevising(true);
    setRevisionError(null);

    try {
      const res = await fetch(`/api/videos/${id}/script/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedback: feedbackText.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Revision failed.');
      }

      setVideo(data);
      if (data.script_json?.beats) {
        setEditableBeats(data.script_json.beats);
      }
      if (data.script_json?.title_options?.length) {
        setSelectedTitle(data.script_json.title_options[0]);
      }
      setFeedbackText('');
      setHasUnsavedEdits(false);
    } catch (err) {
      setRevisionError(
        err instanceof Error ? err.message : 'Error revising script.',
      );
    } finally {
      setIsRevising(false);
    }
  }

  // Handle Approve Script via POST /api/videos/[id]/script/approve
  async function handleApprove() {
    if (!selectedTitle.trim()) return;

    setIsApproving(true);
    setError(null);

    try {
      const res = await fetch(`/api/videos/${id}/script/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedTitle: selectedTitle.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Approval failed.');
      }

      setVideo(data);
      setApprovalSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error approving script.');
    } finally {
      setIsApproving(false);
    }
  }

  // Total runtime calculation
  const totalSeconds = editableBeats.reduce(
    (acc, beat) => acc + (beat.duration_estimate_seconds || 0),
    0,
  );
  const totalMinutesFormatted = (totalSeconds / 60).toFixed(1);

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-6 text-zinc-100">
        <div className="w-10 h-10 border-4 border-zinc-800 border-t-red-500 rounded-full animate-spin mb-4" />
        <p className="text-zinc-400 text-sm">Loading video details...</p>
      </div>
    );
  }

  if (error || !video) {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-6 text-zinc-100">
        <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-6 text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 mx-auto flex items-center justify-center">
            !
          </div>
          <h2 className="text-lg font-bold text-white">Unable to Load Video</h2>
          <p className="text-sm text-zinc-400">{error || 'Video not found.'}</p>
          <div className="flex justify-center gap-3 pt-2">
            <Link
              href="/"
              className="px-4 py-2 rounded-xl bg-zinc-800 text-zinc-200 text-sm hover:bg-zinc-700 transition"
            >
              Dashboard
            </Link>
            <button
              onClick={() => fetchVideo()}
              className="px-4 py-2 rounded-xl bg-red-600 text-white text-sm hover:bg-red-500 transition"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Visual badge renderer
  const renderVisualBadge = (type: ScriptBeat['visual_type']) => {
    switch (type) {
      case 'newspaper':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 border border-amber-500/20 text-amber-400">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            📰 Newspaper
          </span>
        );
      case 'geo_map':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 border border-blue-500/20 text-blue-400">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            🗺️ Map
          </span>
        );
      case 'archive':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-500/10 border border-orange-500/20 text-orange-400">
            <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />
            🏛️ Archive
          </span>
        );
      case 'chart':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            📊 Chart
          </span>
        );
      case 'screen_recording':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
            💻 Screen
          </span>
        );
      case 'stock':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 border border-purple-500/20 text-purple-400">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            🎬 Stock
          </span>
        );
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center py-10 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-5xl space-y-8">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Link href="/" className="hover:text-zinc-200 transition">
              Pipeline Dashboard
            </Link>
            <span>/</span>
            <Link href="/videos/new" className="hover:text-zinc-200 transition">
              New Video
            </Link>
            <span>/</span>
            <span className="text-zinc-200 font-medium">Script Review</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-zinc-400 font-semibold">
              Status:
            </span>
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider ${
                video.status === 'script_review'
                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  : video.status === 'voicing'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : video.status === 'scripting'
                  ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse'
                  : video.status === 'failed'
                  ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                  : 'bg-zinc-800 text-zinc-300'
              }`}
            >
              {video.status}
            </span>
          </div>
        </div>

        {/* Video Topic & Metadata Header */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                Topic Angle
              </p>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                {video.topic}
              </h1>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-zinc-400">
                <span className="flex items-center gap-1.5 bg-zinc-950 px-3 py-1 rounded-lg border border-zinc-800">
                  <span className="text-zinc-400">Style:</span>
                  <span className="font-semibold text-zinc-200 uppercase">{video.style}</span>
                </span>
                <span className="flex items-center gap-1.5 bg-zinc-950 px-3 py-1 rounded-lg border border-zinc-800">
                  <span className="text-zinc-400">Target Duration:</span>
                  <span className="font-semibold text-zinc-200">
                    {video.target_minutes} min
                  </span>
                </span>
                {video.script_json?.beats && (
                  <span className="flex items-center gap-1.5 bg-zinc-950 px-3 py-1 rounded-lg border border-zinc-800">
                    <span className="text-zinc-400">Estimated Duration:</span>
                    <span className="font-semibold text-amber-400">
                      ~{totalMinutesFormatted} min ({totalSeconds}s)
                    </span>
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Case 1: Status = 'scripting' (Generating/Polling) */}
        {video.status === 'scripting' && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-10 text-center space-y-6 shadow-xl">
            <div className="relative flex items-center justify-center">
              <div className="w-16 h-16 rounded-full border-4 border-blue-500/20 border-t-blue-500 animate-spin" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-bold text-white">Script Generation in Progress...</h2>
              <p className="text-sm text-zinc-400 max-w-md mx-auto">
                Claude is currently drafting your script beats and candidate titles. This page will automatically update once ready.
              </p>
            </div>
            <div className="pt-2">
              <span className="inline-flex items-center gap-2 text-xs text-blue-400 bg-blue-950/40 border border-blue-800 px-3 py-1.5 rounded-full">
                <span className="w-2 h-2 rounded-full bg-blue-400 animate-ping" />
                Live Polling Video Status...
              </span>
            </div>
          </div>
        )}

        {/* Case 2: Status = 'failed' */}
        {video.status === 'failed' && (
          <div className="bg-red-950/30 border border-red-800 rounded-2xl p-8 space-y-4 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center font-bold">
                ✕
              </div>
              <div>
                <h2 className="text-lg font-bold text-red-200">Script Generation Failed</h2>
                <p className="text-sm text-red-400/90 mt-1">
                  {video.error_message || 'An error occurred during script generation.'}
                </p>
              </div>
            </div>
            <div className="pt-4 flex gap-4">
              <Link
                href="/videos/new"
                className="px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-sm transition"
              >
                Create New Video
              </Link>
            </div>
          </div>
        )}

        {/* Case 3: Status = 'voicing' or later (Approved) */}
        {video.status !== 'scripting' && video.status !== 'failed' && video.status !== 'script_review' && (
          <div className="bg-emerald-950/30 border border-emerald-800 rounded-2xl p-8 space-y-6 shadow-xl">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-xl shrink-0">
                ✓
              </div>
              <div className="space-y-1">
                <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-semibold mb-1">
                  Ready for Pipeline Stage 2
                </div>
                <h2 className="text-2xl font-bold text-white">
                  Script Approved — {video.title || 'Untitled'}
                </h2>
                {video.script_approved_at && (
                  <p className="text-xs text-zinc-400">
                    Approved at: {new Date(video.script_approved_at).toLocaleString()}
                  </p>
                )}
                {/* Narrator Voice Picker Card */}
                <div className="mt-6 p-6 rounded-2xl bg-zinc-950/80 border border-zinc-800 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-zinc-800/80">
                    <div>
                      <h3 className="text-base font-bold text-white flex items-center gap-2">
                        <span>🎙️ Narrator Voice Selection</span>
                        {styleDefaults[video.style] === selectedNarratorId && selectedNarratorId && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-cyan-500/10 border border-cyan-500/30 text-cyan-300">
                            Pre-selected by Style Default ({video.style})
                          </span>
                        )}
                      </h3>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        Choose the voice actor for this video before initiating the TTS synthesis pipeline.
                      </p>
                    </div>
                    <Link
                      href="/narrators"
                      className="text-xs text-zinc-400 hover:text-white transition flex items-center gap-1"
                    >
                      <span>Manage Defaults & Studio</span>
                      <span>→</span>
                    </Link>
                  </div>

                  {voiceTriggerError && (
                    <div className="p-3 rounded-xl bg-red-950/40 border border-red-800 text-red-300 text-xs">
                      {voiceTriggerError}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider block">
                        Assigned Narrator Voice:
                      </label>
                      <select
                        value={selectedNarratorId}
                        onChange={(e) => setSelectedNarratorId(e.target.value)}
                        className="w-full px-3.5 py-2.5 bg-zinc-900 border border-zinc-700/80 rounded-xl text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
                      >
                        {narrators.length === 0 ? (
                          <option value="">No voices synced yet</option>
                        ) : (
                          narrators.map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.name} — {n.yt_provider_configs?.label || n.provider_slug || 'TTS'} {n.tier ? `(${n.tier})` : ''}
                            </option>
                          ))
                        )}
                      </select>
                    </div>

                    {/* Voice details / Audio Preview */}
                    <div className="space-y-1.5">
                      {(() => {
                        const sel = narrators.find((n) => n.id === selectedNarratorId);
                        if (!sel) {
                          return (
                            <div className="text-xs text-zinc-500 italic p-2 rounded-lg bg-zinc-900/50">
                              Please select a narrator or sync voices in the Narrator Studio.
                            </div>
                          );
                        }
                        return (
                          <div>
                            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block mb-1">
                              Voice Preview:
                            </span>
                            {sel.sample_url ? (
                              <audio
                                controls
                                preload="none"
                                src={sel.sample_url}
                                className="w-full h-9 rounded bg-zinc-900 accent-red-500 text-xs"
                              />
                            ) : (
                              <div className="px-3 py-2 rounded-lg bg-zinc-900/80 border border-zinc-800 text-xs text-zinc-300 flex items-center justify-between">
                                <span className="flex items-center gap-1.5">
                                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                  Local Kokoro Neural Voice
                                </span>
                                <span className="font-mono text-zinc-500">{sel.voice_id}</span>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-zinc-900">
                    <p className="text-xs text-zinc-400">
                      Voicing runs scenes in parallel and generates checkpointed audio files.
                    </p>
                    <div className="flex items-center gap-3 w-full sm:w-auto">
                      <button
                        onClick={handleStartVoicing}
                        disabled={isTriggeringVoice || !selectedNarratorId}
                        className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 active:scale-[0.98] text-white font-bold text-xs shadow-lg shadow-red-600/30 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isTriggeringVoice ? (
                          <>
                            <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            <span>Queuing Voicing Job...</span>
                          </>
                        ) : (
                          <>
                            <span>Start Voicing Pipeline</span>
                            <span>→</span>
                          </>
                        )}
                      </button>
                      <Link
                        href={`/videos/${id}/progress`}
                        className="px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 text-xs font-semibold transition"
                      >
                        View Progress
                      </Link>
                      <Link
                        href={`/videos/${id}/visuals`}
                        className="px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-indigo-400 hover:text-indigo-300 text-xs font-semibold transition"
                      >
                        Upload Visuals →
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Approved Beats (Read-only review) */}
            <div className="pt-4 border-t border-emerald-900/40">
              <h3 className="text-sm font-bold text-zinc-300 uppercase tracking-wider mb-4">
                Approved Script Beats ({video.script_json?.beats?.length || 0})
              </h3>
              <div className="space-y-3">
                {video.script_json?.beats?.map((beat) => (
                  <div
                    key={beat.index}
                    className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 flex flex-col gap-2"
                  >
                    <div className="flex items-center justify-between text-xs text-zinc-400">
                      <span className="font-bold text-zinc-300">Beat #{beat.index}</span>
                      <div className="flex items-center gap-2">
                        {renderVisualBadge(beat.visual_type)}
                        <span className="text-zinc-400">{beat.duration_estimate_seconds}s</span>
                      </div>
                    </div>
                    <p className="text-sm text-zinc-200">{beat.text}</p>
                    <p className="text-xs text-zinc-400 italic">Visual: {beat.visual_query}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Case 4: Status = 'script_review' (Active Review & Approval Flow) */}
        {video.status === 'script_review' && video.script_json && (
          <div className="space-y-8">
            {/* 1. Title Options Selection */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <span>1. Select Video Title</span>
                    <span className="text-xs font-normal text-zinc-400">
                      (Required to approve)
                    </span>
                  </h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Pick one of the LLM-generated title options to lock in for this video.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3">
                {video.script_json.title_options?.map((candidate, idx) => {
                  const isSelected = selectedTitle === candidate;
                  return (
                    <label
                      key={idx}
                      onClick={() => setSelectedTitle(candidate)}
                      className={`flex items-start gap-4 p-4 rounded-xl border cursor-pointer transition ${
                        isSelected
                          ? 'bg-red-950/20 border-red-500/60 shadow-md shadow-red-500/5'
                          : 'bg-zinc-950/70 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-950'
                      }`}
                    >
                      <input
                        type="radio"
                        name="video_title"
                        value={candidate}
                        checked={isSelected}
                        onChange={() => setSelectedTitle(candidate)}
                        className="mt-1 text-red-600 focus:ring-red-500 h-4 w-4 bg-zinc-900 border-zinc-700"
                      />
                      <div className="flex-1">
                        <span className="text-sm font-semibold text-zinc-100">
                          {candidate}
                        </span>
                      </div>
                      {isSelected && (
                        <span className="text-xs font-bold text-red-400 uppercase tracking-wider">
                          Selected
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>

            {/* 2. Structured Script Beats (Editable) */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-xl space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-zinc-800">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <span>2. Review & Refine Beats</span>
                    <span className="text-xs font-normal text-zinc-400">
                      ({editableBeats.length} beats)
                    </span>
                  </h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Make direct inline adjustments to narration text. Save changes directly without re-running the LLM.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsImportModalOpen(true)}
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700 transition flex items-center gap-1.5"
                  >
                    <span>📥 Import / Replace Script</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleAutoVisualHints}
                    disabled={isGeneratingHints || editableBeats.length === 0}
                    className="px-3 py-1.5 rounded-lg bg-indigo-950/60 hover:bg-indigo-900/80 text-indigo-300 text-xs font-semibold border border-indigo-800 transition flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {isGeneratingHints ? 'Generating Hints...' : '✨ Auto Visual Hints'}
                  </button>

                  <button
                    type="button"
                    onClick={() => handleAddBeat()}
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700 transition flex items-center gap-1"
                  >
                    <span>+ Add Beat</span>
                  </button>

                  {saveFeedback && (
                    <span className="text-xs text-emerald-400 font-medium animate-fade-in ml-1">
                      {saveFeedback}
                    </span>
                  )}

                  {hasUnsavedEdits && (
                    <button
                      onClick={handleSaveEdits}
                      disabled={isSavingEdits}
                      className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs transition flex items-center gap-2 shadow-lg shadow-amber-600/20 cursor-pointer disabled:opacity-50"
                    >
                      {isSavingEdits ? 'Saving...' : 'Save Beat Edits'}
                    </button>
                  )}
                </div>
              </div>

              {/* Beat Cards */}
              <div className="space-y-4">
                {editableBeats.map((beat, idx) => {
                  const words = beat.text.trim().split(/\s+/).filter(Boolean).length;
                  const spokenEst = (words / 2.3).toFixed(1);

                  return (
                    <div
                      key={idx}
                      className="p-5 rounded-xl bg-zinc-950/80 border border-zinc-800 hover:border-zinc-700/80 transition space-y-3"
                    >
                      {/* Beat Header: Index, Interactive Type Selector, Duration & Reorder Controls */}
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-900 pb-2">
                        <div className="flex items-center gap-2.5">
                          <span className="px-2.5 py-1 rounded-lg bg-zinc-800 text-zinc-200 font-mono text-xs font-bold">
                            #{idx + 1}
                          </span>
                          <select
                            value={beat.visual_type || 'stock'}
                            onChange={(e) => {
                              const val = e.target.value as ScriptBeat['visual_type'];
                              setEditableBeats((prev) =>
                                prev.map((b) => (b.index === beat.index ? { ...b, visual_type: val } : b)),
                              );
                              setHasUnsavedEdits(true);
                            }}
                            className="text-xs font-semibold rounded-lg px-2.5 py-1 bg-zinc-900 border border-zinc-700 text-zinc-200 hover:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-red-500 cursor-pointer transition"
                            title="Change visual style/type for this beat"
                          >
                            <option value="stock">🎬 Stock B-Roll</option>
                            <option value="newspaper">📰 Newspaper / Headline</option>
                            <option value="geo_map">🗺️ Route Map</option>
                            <option value="chart">📊 Data Chart</option>
                            <option value="archive">🏛️ Historical Archive</option>
                            <option value="screen_recording">💻 Screen Recording</option>
                          </select>
                          <span className="text-[11px] text-zinc-400 font-mono bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">
                            {words} words • ~{spokenEst}s spoken
                          </span>
                        </div>

                        {/* Reorder & Action Controls */}
                        <div className="flex items-center gap-1 text-xs">
                          <button
                            type="button"
                            onClick={() => handleMoveBeat(idx, 'up')}
                            disabled={idx === 0}
                            title="Move Up"
                            className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => handleMoveBeat(idx, 'down')}
                            disabled={idx === editableBeats.length - 1}
                            title="Move Down"
                            className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddBeat(idx)}
                            title="Insert Beat Below"
                            className="px-2 py-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-[11px] font-medium"
                          >
                            + Below
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteBeat(idx)}
                            disabled={editableBeats.length <= 1}
                            title="Delete Beat"
                            className="p-1.5 rounded hover:bg-red-950/50 text-zinc-500 hover:text-red-400 disabled:opacity-30"
                          >
                            ✕
                          </button>
                        </div>
                      </div>

                      {/* Editable Narration Text */}
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-zinc-400">
                          Narration Script:
                        </label>
                        <textarea
                          rows={3}
                          value={beat.text}
                          onChange={(e) => handleBeatTextChange(beat.index, e.target.value)}
                          className="w-full px-3.5 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500 transition resize-y font-sans leading-relaxed"
                        />
                      </div>

                      {/* Visual Search Query Metadata */}
                      <div className="p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 text-xs flex items-center gap-2 text-zinc-400">
                        <span className="font-semibold text-zinc-400">Visual Hint:</span>
                        <input
                          type="text"
                          value={beat.visual_query || ''}
                          onChange={(e) => {
                            const val = e.target.value;
                            setEditableBeats((prev) =>
                              prev.map((b) => (b.index === beat.index ? { ...b, visual_query: val } : b)),
                            );
                            setHasUnsavedEdits(true);
                          }}
                          placeholder="Visual query hint for b-roll sourcing..."
                          className="flex-1 bg-transparent border-0 text-zinc-200 italic font-mono text-xs focus:outline-none focus:ring-0 p-0"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Bottom Action Toolbar */}
              <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60">
                <button
                  type="button"
                  onClick={() => handleAddBeat()}
                  className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold text-xs transition"
                >
                  + Add Beat to End
                </button>

                {hasUnsavedEdits && (
                  <button
                    onClick={handleSaveEdits}
                    disabled={isSavingEdits}
                    className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs transition flex items-center gap-2 cursor-pointer shadow-lg shadow-amber-600/20"
                  >
                    {isSavingEdits ? 'Saving Edits...' : 'Save All Beat Edits'}
                  </button>
                )}
              </div>
            </div>

            {/* 3. Request Changes Section (LLM Revision) */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-xl space-y-4">
              <div>
                <h2 className="text-lg font-bold text-white">
                  3. Request AI Revisions (Optional)
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Need structural changes, a different tone, or new beats? Provide instructions for Claude to regenerate the script.
                </p>
              </div>

              {revisionError && (
                <div className="p-3.5 rounded-xl bg-red-950/40 border border-red-800 text-red-200 text-xs">
                  {revisionError}
                </div>
              )}

              <form onSubmit={handleRevise} className="space-y-3">
                <textarea
                  rows={3}
                  disabled={isRevising}
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  placeholder="e.g. Make the hook punchier, add a beat explaining the performance comparison with SQLite vs PostgreSQL, and use more chart visuals."
                  className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition disabled:opacity-60"
                />

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isRevising || !feedbackText.trim()}
                    className="px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-900 text-white font-medium text-xs sm:text-sm transition flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed border border-zinc-700"
                  >
                    {isRevising ? (
                      <>
                        <span className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                        <span>Revising Script with Claude...</span>
                      </>
                    ) : (
                      <>
                        <svg
                          className="w-4 h-4 text-blue-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        </svg>
                        <span>Request AI Revision</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>

            {/* 4. Script Approval Action Card */}
            <div className="bg-gradient-to-r from-red-950/30 via-zinc-900 to-zinc-900 border border-red-900/40 rounded-2xl p-6 sm:p-8 shadow-2xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
              <div>
                <span className="text-xs uppercase tracking-wider font-bold text-red-400">
                  Final Step
                </span>
                <h3 className="text-xl font-bold text-white mt-1">
                  Ready to lock in the script?
                </h3>
                <p className="text-xs text-zinc-400 mt-1 max-w-lg">
                  {selectedTitle
                    ? `Selected Title: "${selectedTitle}". Approving transitions this video to the voicing stage.`
                    : 'Please select a title option in Step 1 to enable approval.'}
                </p>
              </div>

              <div>
                <button
                  onClick={handleApprove}
                  disabled={!selectedTitle || isApproving}
                  className={`w-full sm:w-auto px-8 py-3.5 rounded-xl font-bold text-sm shadow-xl transition-all flex items-center justify-center gap-2 cursor-pointer ${
                    !selectedTitle || isApproving
                      ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700/50'
                      : 'bg-red-600 hover:bg-red-500 active:bg-red-700 text-white shadow-red-600/30 hover:scale-[1.02]'
                  }`}
                >
                  {isApproving ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                      <span>Approving Script...</span>
                    </>
                  ) : (
                    <>
                      <span>Approve Script & Advance to Voicing</span>
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* SCRIPT IMPORT MODAL */}
        {isImportModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in font-sans">
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-xl p-6 shadow-2xl space-y-5">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                <div>
                  <h3 className="text-base font-bold text-white">Import / Replace Script</h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Overwrite current beats with pre-written text or timed SRT subtitles.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsImportModalOpen(false)}
                  className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800"
                >
                  ✕
                </button>
              </div>

              {/* Mode Tabs */}
              <div className="flex items-center gap-2 p-1 bg-zinc-950 rounded-xl border border-zinc-800">
                <button
                  type="button"
                  onClick={() => setImportTab('raw')}
                  className={`flex-1 py-1.5 px-3 text-xs font-medium rounded-lg transition ${
                    importTab === 'raw'
                      ? 'bg-zinc-800 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  📝 Text / Markdown
                </button>
                <button
                  type="button"
                  onClick={() => setImportTab('srt')}
                  className={`flex-1 py-1.5 px-3 text-xs font-medium rounded-lg transition ${
                    importTab === 'srt'
                      ? 'bg-zinc-800 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  ⏱️ SRT Subtitles
                </button>
              </div>

              {importError && (
                <div className="p-3 rounded-lg bg-red-950/60 border border-red-800 text-xs text-red-200">
                  ⚠️ {importError}
                </div>
              )}

              {/* TAB 1: RAW TEXT */}
              {importTab === 'raw' && (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-400">
                      Paste Script Text (scenes separated by blank lines):
                    </label>
                    <textarea
                      rows={6}
                      value={importRawText}
                      onChange={(e) => setImportRawText(e.target.value)}
                      placeholder="Paste your narration script here..."
                      className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-xs text-zinc-100 font-mono focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800/80 space-y-2">
                    <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block">
                      Segmentation Strategy:
                    </span>
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-zinc-300">
                      <input
                        type="radio"
                        name="importRawMode"
                        checked={importRawMode === 'raw_paragraphs'}
                        onChange={() => setImportRawMode('raw_paragraphs')}
                        className="text-indigo-600 focus:ring-0"
                      />
                      <span>Instant Paragraph Split (Zero AI)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-zinc-300">
                      <input
                        type="radio"
                        name="importRawMode"
                        checked={importRawMode === 'raw_ai'}
                        onChange={() => setImportRawMode('raw_ai')}
                        className="text-indigo-600 focus:ring-0"
                      />
                      <span>AI Beat Segmentation & Visual Queries</span>
                    </label>
                  </div>
                </div>
              )}

              {/* TAB 2: SRT */}
              {importTab === 'srt' && (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-400">
                      Paste SRT Subtitle Content:
                    </label>
                    <textarea
                      rows={6}
                      value={importSrtText}
                      onChange={(e) => setImportSrtText(e.target.value)}
                      placeholder={`1\n00:00:01,000 --> 00:00:04,500\nFirst line...\n\n2\n00:00:04,600 --> 00:00:08,000\nSecond line...`}
                      className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-xs text-zinc-100 font-mono focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800/80">
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={importSmartMerge}
                        onChange={(e) => setImportSmartMerge(e.target.checked)}
                        className="rounded text-indigo-600 focus:ring-0"
                      />
                      <span>Smart Scene Merging (combines short 1–2s cues into ~4–8s beats)</span>
                    </label>
                  </div>
                </div>
              )}

              {/* Modal Actions */}
              <div className="flex items-center justify-end gap-3 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsImportModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleImportScript}
                  disabled={isImporting}
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow-lg shadow-indigo-600/30 transition disabled:opacity-50"
                >
                  {isImporting ? 'Importing Script...' : 'Replace & Apply Beats'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
