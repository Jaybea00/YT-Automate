'use client';

import React from 'react';
import Link from 'next/link';
import type { VideoRecord } from '@/lib/types/video';
import { SENTENCE_BREATH_SEC, VOICE_SPEED_OPTIONS } from '@/lib/script/voice-pacing';
import { VisualBadge } from './visual-badge';

/**
 * After approval: the narrator, voice speed and breath for this video, the button that voices it,
 * and the approved beats to read through.
 */

export interface NarratorOption {
  id: string;
  voice_id: string;
  name: string;
  sample_url: string | null;
  tier: string | null;
  provider_slug: string | null;
  yt_provider_configs?: { label?: string; provider?: string } | null;
}

export function VoicingPanel({
  id,
  video,
  narrators,
  styleDefaults,
  selectedNarratorId,
  setSelectedNarratorId,
  voiceSpeed,
  setVoiceSpeed,
  breathSec,
  setBreathSec,
  isTriggeringVoice,
  voiceTriggerError,
  onStartVoicing,
}: {
  id: string;
  video: VideoRecord;
  narrators: NarratorOption[];
  styleDefaults: Record<string, string>;
  selectedNarratorId: string;
  setSelectedNarratorId: (id: string) => void;
  voiceSpeed: number;
  setVoiceSpeed: (speed: number) => void;
  breathSec: number;
  setBreathSec: (sec: number) => void;
  isTriggeringVoice: boolean;
  voiceTriggerError: string | null;
  onStartVoicing: () => void;
}) {
  return (
    <>
      {/* Case 3: Status = 'voicing' or later (Approved), or a later stage failed: pick a narrator and voice again */}
      {video.status !== 'scripting' && video.status !== 'script_review' && (video.status !== 'failed' || Boolean(video.script_json?.beats?.length)) && (
        <div className="bg-emerald-950/30 border border-emerald-800 rounded-2xl p-4 sm:p-8 space-y-6 shadow-xl">
          <div className="flex items-start gap-4">
            <div className="hidden sm:flex w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 items-center justify-center font-bold text-xl shrink-0">
              ✓
            </div>
            <div className="space-y-1 min-w-0 flex-1">
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
              {video.status === 'failed' && (
                <div className="mt-3 p-3 rounded-xl bg-red-950/40 border border-red-800 text-xs text-red-200">
                  The last stage failed{video.error_message ? `: ${video.error_message}` : '.'} Your script is safe: pick a narrator below
                  (a Kokoro voice is free and unlimited) and start voicing again.
                </div>
              )}
              {/* Narrator Voice Picker Card */}
              <div className="mt-6 p-4 sm:p-6 rounded-2xl bg-zinc-950/80 border border-zinc-800 space-y-4">
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
                                {sel.provider_slug === 'gemini-tts' || sel.yt_provider_configs?.provider === 'gemini-tts'
                                  ? 'Gemini cloud voice'
                                  : 'Local Kokoro Neural Voice'}
                              </span>
                              <span className="font-mono text-zinc-500 truncate">{sel.voice_id}</span>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Voice pace for this video */}
                <div className="space-y-2 pt-1">
                  <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Voice speed</span>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      ...VOICE_SPEED_OPTIONS,
                      ...(VOICE_SPEED_OPTIONS.some((o) => o.speed === voiceSpeed) ? [] : [{ speed: voiceSpeed, label: 'Style pace', desc: `${Math.round(voiceSpeed * 100)}% of normal` }]),
                    ].map((o) => (
                      <button
                        key={o.speed}
                        type="button"
                        onClick={() => setVoiceSpeed(o.speed)}
                        className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                          voiceSpeed === o.speed ? 'bg-indigo-950/40 border-indigo-500/80 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                        }`}
                      >
                        <span className="block text-xs font-medium">{o.label}</span>
                        <span className="block text-[10px] text-zinc-400 mt-0.5">{o.desc}</span>
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                    <input type="checkbox" checked={breathSec > 0} onChange={(e) => setBreathSec(e.target.checked ? SENTENCE_BREATH_SEC : 0)} className="accent-indigo-500" />
                    A short breath after each sentence
                  </label>
                  <p className="text-[11px] text-zinc-500">
                    Speed works with Kokoro and ElevenLabs voices; the breath needs Kokoro. Gemini voices keep their own pace. A new speed re-voices every beat.
                  </p>
                </div>

                <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-zinc-900">
                  <p className="text-xs text-zinc-400">
                    Voicing runs scenes in parallel and generates checkpointed audio files.
                  </p>
                  <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
                    <button
                      onClick={onStartVoicing}
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
                      <VisualBadge type={beat.visual_type} />
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
    </>
  );
}
