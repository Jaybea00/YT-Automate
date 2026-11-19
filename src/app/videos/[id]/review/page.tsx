'use client';

import React, { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { ActionBar } from '@/components/ui/action-bar';
import { VoicingPanel, type NarratorOption } from './voicing-panel';
import { ImportScriptDialog } from './import-script-dialog';
import { PageContainer, PageHeader, EmptyState } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useRouter } from 'next/navigation';
import { VideoRecord } from '@/lib/types/video';
import { ScriptBeat } from '@/lib/script/generate-script';
import { applyResearchToBeats } from '@/lib/script/script-quality';
import { ResearchPanel, BeatSources } from './research-panel';
import { OutlineEditor } from './outline-editor';
import { BeatFactIssues, FactCheckPanel } from './fact-check-panel';
import type { FactCheckReport } from '@/lib/script/fact-check-issues';
import { PronunciationPanel } from './pronunciation-panel';
import { AdCheckPanel, BeatAdIssues } from './ad-check-panel';
import { PackagingSummary } from './packaging-card';
import type { AdCheckReport } from '@/lib/script/ad-check-issues';
import { BeatRetentionIssues, RetentionPanel } from './retention-panel';
import type { RetentionReport } from '@/lib/script/retention-types';
import { BeatShots, ShotPlanSummary } from './shots-panel';
import { DrawingsPanel } from '../drawings-panel';
import { packForVideo } from '@/lib/styles/compose';
import { CreationProgress, creationOf, RetryCreationButton } from './creation-progress';
import { videoPacing } from '@/lib/script/voice-pacing';
import { BeatRewritePanel, HookLab, RuntimeMeter, ScriptDoctor } from './editor-panels';

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
  const [, setApprovalSuccess] = useState(false);

  // Narrator State
  const [narrators, setNarrators] = useState<NarratorOption[]>([]);
  const [styleDefaults, setStyleDefaults] = useState<Record<string, string>>({});
  const [selectedNarratorId, setSelectedNarratorId] = useState<string>('');
  const [voiceSpeed, setVoiceSpeed] = useState<number>(1);
  const [breathSec, setBreathSec] = useState<number>(0);
  const [isTriggeringVoice, setIsTriggeringVoice] = useState(false);
  const [voiceTriggerError, setVoiceTriggerError] = useState<string | null>(null);

  // Script Import & Enhancement State
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isGeneratingHints, setIsGeneratingHints] = useState(false);
  const [isPlanningShots, setIsPlanningShots] = useState(false);
  const [shotPlanError, setShotPlanError] = useState<string | null>(null);

  // Beat rewrite panel (key remounts it so a doctor fix starts a fresh run) and per-beat undo
  const [rewriteTarget, setRewriteTarget] = useState<{ index: number; instruction?: string; key: number } | null>(null);
  const [previousBeats, setPreviousBeats] = useState<Record<number, ScriptBeat>>({});

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
      // The voice pace starts at the video's own (or its style's)
      const pace = videoPacing((data.script_json as { voice_pacing?: unknown } | null)?.voice_pacing, data.style, packForVideo(data));
      setVoiceSpeed(pace?.speed ?? 1);
      setBreathSec(pace?.sentencePauseSec ?? 0);

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

        let loadedNarrators: typeof narrators = [];
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
          if (video.narrator_id) {
            setSelectedNarratorId(video.narrator_id);
          } else if (defaultNarratorId && loadedNarrators.some((n) => n.id === defaultNarratorId)) {
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
  }, [video?.id, video?.style, video?.narrator_id]);

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
      payload.voicePacing = { speed: voiceSpeed, sentencePauseSec: breathSec };

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
    // Started from a microtask: fetchVideo sets state only once its request answers
    void Promise.resolve().then(() => fetchVideo());
  }, [id]);

  // Polling when in 'scripting' status
  useEffect(() => {
    if (!video || video.status !== 'scripting') return;

    const interval = setInterval(() => {
      fetchVideo(true);
    }, 3000);

    return () => clearInterval(interval);
  }, [video?.status, id]);

  function setFactCheck(report: FactCheckReport) {
    setVideo((v) => (v && v.script_json ? { ...v, script_json: { ...v.script_json, fact_check: report } } : v));
  }

  function setAdCheck(report: AdCheckReport) {
    setVideo((v) => (v && v.script_json ? { ...v, script_json: { ...v.script_json, ad_check: report } } : v));
  }

  function setRetention(report: RetentionReport) {
    setVideo((v) => (v && v.script_json ? { ...v, script_json: { ...v.script_json, retention: report } } : v));
  }

  /** Uses a suggested rewrite of a beat's narration, keeping the old text for undo. */
  function applyRewrittenText(index: number, text: string) {
    const beat = editableBeats[index];
    if (beat) applyBeatReplacement(index, { ...beat, text });
  }

  // Handle Beat Text Edit (re-evaluates the "needs check" flag against the research dossier)
  function handleBeatTextChange(index: number, newText: string) {
    const research = video?.script_json?.research;
    setEditableBeats((prev) =>
      prev.map((beat) => {
        if (beat.index !== index) return beat;
        // Shot word ranges no longer match edited narration, so the beat needs re-planning
        const edited = { ...beat, text: newText, shots: undefined };
        // Only refresh the flag here; never override a visual type the user picked
        return research ? applyResearchToBeats([edited], research, { enforceVisualRules: false })[0] : edited;
      }),
    );
    setHasUnsavedEdits(true);
    setSaveFeedback(null);
  }

  async function handlePlanShots(onlyMissing: boolean) {
    setIsPlanningShots(true);
    setShotPlanError(null);
    try {
      const beatIndexes = onlyMissing
        ? editableBeats.filter((b) => !b.shots?.length).map((b) => b.index)
        : undefined;
      const res = await fetch(`/api/videos/${id}/script/shots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beatIndexes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to plan shots');
      await fetchVideo(true);
    } catch (err) {
      setShotPlanError(err instanceof Error ? err.message : 'Failed to plan shots');
    } finally {
      setIsPlanningShots(false);
    }
  }

  function handleMarkChecked(index: number) {
    setEditableBeats((prev) => prev.map((b) => (b.index === index ? { ...b, needs_check: false } : b)));
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
    resetBeatPositionState();
    setHasUnsavedEdits(true);
    setSaveFeedback(null);
  }

  /** Undo history and an open rewrite panel are keyed by position, so they reset when beats move. */
  function resetBeatPositionState() {
    setPreviousBeats({});
    setRewriteTarget(null);
  }

  /** Replaces a beat with a chosen rewrite or hook, remembering the old version for undo. */
  function applyBeatReplacement(index: number, replacement: ScriptBeat) {
    const current = editableBeats[index];
    if (!current) return;
    setPreviousBeats((prev) => ({ ...prev, [index]: current }));
    setEditableBeats((prev) =>
      prev.map((b, i) => (i === index ? { ...replacement, index, shots: undefined } : b)),
    );
    setRewriteTarget(null);
    setHasUnsavedEdits(true);
    setSaveFeedback(null);
  }

  function handleUndoBeat(index: number) {
    const previous = previousBeats[index];
    if (!previous) return;
    setEditableBeats((prev) => prev.map((b, i) => (i === index ? previous : b)));
    setPreviousBeats((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setHasUnsavedEdits(true);
    setSaveFeedback(null);
  }

  function openRewrite(index: number, instruction?: string) {
    setRewriteTarget({ index, instruction, key: Date.now() });
    document.getElementById(`beat-card-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    resetBeatPositionState();
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
    resetBeatPositionState();
    setHasUnsavedEdits(true);
    setSaveFeedback(null);
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
    const flagged = editableBeats.filter((b) => b.needs_check).length;
    if (
      flagged > 0 &&
      !window.confirm(
        `${flagged} beat${flagged === 1 ? '' : 's'} state numbers or quotes that no researched source backs. Approve anyway?`,
      )
    ) {
      return;
    }

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
      <PageContainer>
        <EmptyState loading title="Loading the script…" />
      </PageContainer>
    );
  }

  if (error || !video) {
    return (
      <PageContainer>
        <EmptyState
          title="Could not load this video"
          description={error || 'Video not found.'}
          action={
            <Button variant="primary" icon="refresh" onClick={() => fetchVideo()}>
              Retry
            </Button>
          }
        />
      </PageContainer>
    );
  }


  return (
    <PageContainer>
        <PageHeader
          eyebrow="Script"
          title={video.topic}
          meta={
            <>
              <Badge>{String(video.style ?? '').replace(/_/g, ' ')}</Badge>
              <Badge>Target {video.target_minutes} min</Badge>
              {video.script_json?.beats?.length ? (
                <Badge tone="warning">
                  About {totalMinutesFormatted} min ({Math.round(totalSeconds)} s)
                </Badge>
              ) : null}
            </>
          }
        />

        {/* Case 1: Status = 'scripting' (Generating/Polling) */}
        {video.status === 'scripting' && (
          <CreationProgress videoId={id} scriptJson={video.script_json} onRetried={() => fetchVideo(true)} />
        )}

        {/* Case 2: Status = 'failed' before a script exists (a failure after approval keeps the voicing panel below) */}
        {video.status === 'failed' && !video.script_json?.beats?.length && (
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
            <div className="pt-4 flex flex-wrap items-start gap-4">
              {creationOf(video.script_json) && <RetryCreationButton videoId={id} onRetried={() => fetchVideo(true)} />}
              <Link
                href="/videos/new"
                className="px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-sm transition"
              >
                Create New Video
              </Link>
            </div>
          </div>
        )}

        <VoicingPanel
          id={id}
          video={video}
          narrators={narrators}
          styleDefaults={styleDefaults}
          selectedNarratorId={selectedNarratorId}
          setSelectedNarratorId={setSelectedNarratorId}
          voiceSpeed={voiceSpeed}
          setVoiceSpeed={setVoiceSpeed}
          breathSec={breathSec}
          setBreathSec={setBreathSec}
          isTriggeringVoice={isTriggeringVoice}
          voiceTriggerError={voiceTriggerError}
          onStartVoicing={handleStartVoicing}
        />

        {/* Brief mode: the outline is approved before the full script is written */}
        {video.status === 'script_review' && video.script_json?.outline && !video.script_json.beats?.length && (
          <OutlineEditor
            video={video}
            onWritten={(written) => {
              setVideo(written);
              setEditableBeats(written.script_json?.beats ?? []);
              setSelectedTitle(written.script_json?.title_options?.[0] ?? '');
            }}
          />
        )}

        {/* Case 4: Status = 'script_review' (Active Review & Approval Flow) */}
        {video.status === 'script_review' && video.script_json && !(video.script_json.outline && !video.script_json.beats?.length) && (
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
                  <h2 className="text-lg font-bold text-white flex flex-wrap items-center gap-2">
                    <span>2. Review & Refine Beats</span>
                    <span className="text-xs font-normal text-zinc-400">
                      ({editableBeats.length} beats)
                    </span>
                    <RuntimeMeter beats={editableBeats} targetMinutes={video.target_minutes} style={video.style} pack={packForVideo(video)} />
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

              <PackagingSummary packaging={video.script_json.packaging} />
              <ResearchPanel research={video.script_json.research} beats={editableBeats} />
              <FactCheckPanel videoId={id} report={video.script_json.fact_check} beats={editableBeats} onReport={setFactCheck} />
              <AdCheckPanel videoId={id} report={video.script_json.ad_check} beats={editableBeats} onReport={setAdCheck} />
              <RetentionPanel
                videoId={id}
                report={video.script_json.retention}
                beats={editableBeats}
                onReport={setRetention}
                onUseAll={(fixes) => fixes.forEach((f) => applyRewrittenText(f.beatIndex, f.text))}
              />
              <PronunciationPanel
                key={video.script_json.pronunciation_hints?.checkedAt ?? 'none'}
                videoId={id}
                hints={video.script_json.pronunciation_hints}
                beats={editableBeats}
                onHints={(pronunciation_hints) =>
                  setVideo((v) => (v && v.script_json ? { ...v, script_json: { ...v.script_json, pronunciation_hints } } : v))
                }
              />
              <ShotPlanSummary
                beats={editableBeats}
                isPlanning={isPlanningShots}
                hasUnsavedEdits={hasUnsavedEdits}
                onPlanMissing={() => handlePlanShots(true)}
                onReplanAll={() => handlePlanShots(false)}
                style={video.style}
                pack={packForVideo(video)}
              />
              {shotPlanError && (
                <div className="p-3 rounded-xl bg-red-950/40 border border-red-800 text-red-200 text-xs">
                  {shotPlanError}
                </div>
              )}
              {packForVideo(video)?.drawn && (
                <DrawingsPanel
                  videoId={id}
                  beats={editableBeats}
                  showBudget
                  savedBudget={video.script_json.drawing_budget ?? null}
                  onBeats={() => fetchVideo(true)}
                  bibleTranslation={packForVideo(video)?.signatureShots?.includes('verse') ? (video.script_json.bible_translation ?? 'webbe') : undefined}
                />
              )}

              <HookLab videoId={id} beats={editableBeats} onApply={(hook) => applyBeatReplacement(0, hook)} />
              <ScriptDoctor
                videoId={id}
                beats={editableBeats}
                review={video.script_json.review}
                onReviewed={(review) =>
                  setVideo((v) => (v && v.script_json ? { ...v, script_json: { ...v.script_json, review } } : v))
                }
                onFix={(beatIndex, instruction) => openRewrite(beatIndex, instruction)}
              />

              {/* Beat Cards */}
              <div className="space-y-4">
                {editableBeats.map((beat, idx) => {
                  const words = beat.text.trim().split(/\s+/).filter(Boolean).length;
                  const spokenEst = (words / 2.3).toFixed(1);

                  return (
                    <div
                      key={idx}
                      id={`beat-card-${idx}`}
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
                            onClick={() =>
                              rewriteTarget?.index === idx ? setRewriteTarget(null) : openRewrite(idx)
                            }
                            title="Rewrite this beat with AI"
                            className="px-2 py-1 rounded hover:bg-indigo-950/60 text-indigo-300 hover:text-indigo-200 text-[11px] font-medium"
                          >
                            ✨ Rewrite
                          </button>
                          {previousBeats[idx] && (
                            <button
                              type="button"
                              onClick={() => handleUndoBeat(idx)}
                              title="Restore the version before the last rewrite"
                              className="px-2 py-1 rounded hover:bg-zinc-800 text-zinc-300 text-[11px] font-medium"
                            >
                              ↶ Undo
                            </button>
                          )}
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

                      {/…|\.\.\./.test(beat.text) && (
                        <p className="text-[11px] text-sky-300/80">
                          ⏸ The narrator pauses at each “…” in this beat.
                        </p>
                      )}

                      <BeatSources
                        beat={beat}
                        research={video.script_json?.research}
                        onMarkChecked={() => handleMarkChecked(beat.index)}
                      />

                      <BeatFactIssues
                        videoId={id}
                        beat={beat}
                        report={video.script_json?.fact_check}
                        onReport={setFactCheck}
                        onUseSuggestion={(text) => handleBeatTextChange(beat.index, text)}
                      />
                      <BeatAdIssues
                        videoId={id}
                        beat={beat}
                        report={video.script_json?.ad_check}
                        onReport={setAdCheck}
                        onUseSuggestion={(text) => handleBeatTextChange(beat.index, text)}
                        onRewrite={(instruction) => openRewrite(idx, instruction)}
                      />
                      <BeatRetentionIssues
                        videoId={id}
                        beat={beat}
                        report={video.script_json?.retention}
                        onReport={setRetention}
                        onUseSuggestion={(text) => applyRewrittenText(idx, text)}
                        onRewrite={(instruction) => openRewrite(idx, instruction)}
                      />

                      <BeatShots beat={beat} />

                      {rewriteTarget?.index === idx && (
                        <BeatRewritePanel
                          key={rewriteTarget.key}
                          videoId={id}
                          beats={editableBeats}
                          index={idx}
                          initialInstruction={rewriteTarget.instruction}
                          onApply={(replacement) => applyBeatReplacement(idx, replacement)}
                          onClose={() => setRewriteTarget(null)}
                        />
                      )}
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

        {isImportModalOpen && (
          <ImportScriptDialog
            videoId={id}
            onClose={() => setIsImportModalOpen(false)}
            onImported={async (beats) => {
              if (beats) setEditableBeats(beats);
              setHasUnsavedEdits(false);
              setIsImportModalOpen(false);
              await fetchVideo(true);
            }}
          />
        )}

        {video.status === 'script_review' && (
          <ActionBar hint={selectedTitle ? `Title: “${selectedTitle}”. Approving sends the script to voicing.` : 'Pick a title above to approve the script.'}>
            <Button variant="primary" icon="check" onClick={handleApprove} disabled={!selectedTitle || isApproving}>
              {isApproving ? 'Approving…' : 'Approve script'}
            </Button>
          </ActionBar>
        )}
        {['voicing', 'sourcing'].includes(video.status) && (
          <ActionBar hint="The script is approved. Voice it with the narrator above, then add the visuals.">
            <Button variant="primary" icon="mic" onClick={handleStartVoicing} disabled={isTriggeringVoice || !selectedNarratorId}>
              {isTriggeringVoice ? 'Starting…' : 'Start voicing'}
            </Button>
          </ActionBar>
        )}
    </PageContainer>
  );
}
