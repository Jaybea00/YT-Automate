'use client';

import React, { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { PronunciationEditor } from './pronunciation-editor';

interface ProviderConfig {
  id: string;
  label: string;
  provider: string;
  is_active: boolean;
}

interface Narrator {
  id: string;
  provider_config_id: string;
  voice_id: string;
  name: string;
  sample_url: string | null;
  tier: string | null;
  created_at: string;
  provider_slug: string | null;
  yt_provider_configs?: ProviderConfig | null;
}

/** Where a voice without a preview clip runs, by provider slug. */
function voiceSourceLabel(provider: string | null | undefined): string {
  if (provider === 'gemini-tts') return 'Gemini cloud voice';
  if (provider === 'openai-compatible') return 'Local Kokoro Neural';
  return 'Synthetic voice';
}

const VIDEO_STYLES: Array<{ key: string; label: string; description: string; icon: string }> = [
  { key: 'tech', label: 'Tech Explainer', description: 'Fast-paced, authoritative technical breakdown', icon: '💻' },
  { key: 'cinematic', label: 'Cinematic Doc', description: 'Deep, atmospheric, dramatic storytelling', icon: '🎬' },
  { key: 'modernmba', label: 'Business Analysis', description: 'Polished, strategic, corporate insight', icon: '📈' },
  { key: 'listicle', label: 'Listicle / Fast Facts', description: 'Energetic, punchy, high-retention pacing', icon: '⚡' },
  { key: 'story_driven', label: 'Story Driven', description: 'Immersive narrative with emotional arc', icon: '📖' },
  { key: 'comparison', label: 'Head-to-Head', description: 'Balanced, analytical, objective comparison', icon: '⚖️' },
  { key: 'eli5', label: 'Explain Like I\'m 5', description: 'Warm, approachable, simplified breakdown', icon: '💡' },
  { key: 'true_crime_pov', label: 'True Crime POV', description: 'Dark, tense, suspenseful first-person atmosphere', icon: '🔍' },
  { key: 'vox_explainer', label: 'Vox Explainer', description: 'Curious, conversational, evidence-driven', icon: '🧭' },
];

export default function NarratorsPage() {
  const [narrators, setNarrators] = useState<Narrator[]>([]);
  const [styleDefaults, setStyleDefaults] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingProviderId, setSyncingProviderId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [savingStyle, setSavingStyle] = useState<string | null>(null);

  // Fetch Narrators and Style Defaults
  const loadData = async () => {
    try {
      setLoading(true);
      const [narratorsRes, defaultsRes] = await Promise.all([
        fetch('/api/narrators'),
        fetch('/api/narrators/defaults'),
      ]);

      if (narratorsRes.ok) {
        const narratorsData = await narratorsRes.json();
        setNarrators(Array.isArray(narratorsData) ? narratorsData : []);
      }

      if (defaultsRes.ok) {
        const defaultsData = await defaultsRes.json();
        setStyleDefaults(defaultsData.defaults || {});
      }
    } catch (err) {
      console.error('Failed to load narrator data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Sync handler (sync all or specific provider)
  const handleSync = async (providerConfigId?: string) => {
    if (providerConfigId) {
      setSyncingProviderId(providerConfigId);
    } else {
      setSyncingAll(true);
    }
    setSyncMessage(null);

    try {
      const res = await fetch('/api/narrators/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(providerConfigId ? { providerConfigId } : {}),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to sync voices.');
      }

      setSyncMessage({
        text: `Successfully synced ${data.totalSynced ?? 0} voices across ${data.providers?.length ?? 1} provider(s).`,
        type: 'success',
      });
      await loadData();
    } catch (err) {
      setSyncMessage({
        text: err instanceof Error ? err.message : 'Error syncing narrators.',
        type: 'error',
      });
    } finally {
      setSyncingAll(false);
      setSyncingProviderId(null);
    }
  };

  // Update default narrator for a video style
  const handleUpdateDefault = async (style: string, narratorId: string) => {
    setSavingStyle(style);
    try {
      const res = await fetch('/api/narrators/defaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          style,
          narratorId: narratorId || null,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to update style default');
      }

      setStyleDefaults((prev) => {
        const next = { ...prev };
        if (narratorId) {
          next[style] = narratorId;
        } else {
          delete next[style];
        }
        return next;
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error setting style default');
    } finally {
      setSavingStyle(null);
    }
  };

  // Group narrators by provider
  const groupedNarrators = useMemo(() => {
    const groups: Record<string, { label: string; providerId: string; providerSlug: string; items: Narrator[] }> = {};

    for (const narrator of narrators) {
      const providerConfigId = narrator.provider_config_id || 'unassigned';
      const label = narrator.yt_provider_configs?.label || narrator.provider_slug || 'External Provider';
      const slug = narrator.yt_provider_configs?.provider || narrator.provider_slug || 'tts';

      if (!groups[providerConfigId]) {
        groups[providerConfigId] = {
          label,
          providerId: providerConfigId,
          providerSlug: slug,
          items: [],
        };
      }
      groups[providerConfigId].items.push(narrator);
    }

    return Object.values(groups);
  }, [narrators]);

  // Filtered by search
  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groupedNarrators;
    const q = searchQuery.toLowerCase().trim();

    return groupedNarrators
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (n) =>
            n.name.toLowerCase().includes(q) ||
            n.voice_id.toLowerCase().includes(q) ||
            (n.tier && n.tier.toLowerCase().includes(q)),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [groupedNarrators, searchQuery]);

  // Color helper for tiers
  const getTierBadge = (tier: string | null) => {
    if (!tier) return null;
    const upper = tier.toUpperCase();
    if (upper.includes('A') || upper.includes('PREMADE')) {
      return (
        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide uppercase bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
          Tier {tier}
        </span>
      );
    }
    if (upper.includes('B') || upper.includes('PROFESSIONAL')) {
      return (
        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide uppercase bg-blue-500/10 border border-blue-500/30 text-blue-400">
          Tier {tier}
        </span>
      );
    }
    if (upper.includes('C')) {
      return (
        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide uppercase bg-amber-500/10 border border-amber-500/30 text-amber-400">
          Tier {tier}
        </span>
      );
    }
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide uppercase bg-zinc-800 border border-zinc-700 text-zinc-300">
        {tier}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 py-10 px-4 sm:px-6 lg:px-8 font-sans selection:bg-red-500/30">
      <div className="max-w-6xl mx-auto space-y-10">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Link href="/" className="hover:text-zinc-200 transition-colors">
              Pipeline Dashboard
            </Link>
            <span>/</span>
            <span className="text-zinc-200 font-medium">Narrators & Voice Studio</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => handleSync()}
              disabled={syncingAll || Boolean(syncingProviderId)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 active:scale-[0.98] text-white font-semibold text-xs shadow-lg shadow-red-600/25 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {syncingAll ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Syncing All Providers...</span>
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Sync All Providers</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Hero Header */}
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-zinc-900 via-zinc-900/90 to-zinc-950 border border-zinc-800 p-8 sm:p-10 shadow-2xl">
          <div className="absolute top-0 right-0 w-96 h-96 bg-red-600/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20" />
          <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                Multi-Voice Synthesis Engine
              </div>
              <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
                Narrator & Voice Picker
              </h1>
              <p className="text-zinc-400 text-sm max-w-2xl leading-relaxed">
                Sync and audit voice rosters from Kokoro (Local Neural Engine) and ElevenLabs. Configure permanent style-to-voice mappings so video pipelines auto-assign the optimal voice.
              </p>
            </div>

            {/* Quick Stats Badges */}
            <div className="flex flex-wrap md:flex-col gap-3 shrink-0">
              <div className="px-4 py-2 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex items-center justify-between gap-4">
                <span className="text-xs text-zinc-400">Total Voices:</span>
                <span className="text-sm font-mono font-bold text-white">{narrators.length}</span>
              </div>
              <div className="px-4 py-2 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex items-center justify-between gap-4">
                <span className="text-xs text-zinc-400">Active Providers:</span>
                <span className="text-sm font-mono font-bold text-emerald-400">{groupedNarrators.length}</span>
              </div>
              <div className="px-4 py-2 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex items-center justify-between gap-4">
                <span className="text-xs text-zinc-400">Style Defaults:</span>
                <span className="text-sm font-mono font-bold text-cyan-400">
                  {Object.keys(styleDefaults).length} / {VIDEO_STYLES.length}
                </span>
              </div>
            </div>
          </div>

          {/* Sync Message Feedback */}
          {syncMessage && (
            <div
              className={`mt-6 p-4 rounded-xl text-xs font-medium border flex items-center justify-between ${
                syncMessage.type === 'success'
                  ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                  : 'bg-red-950/40 border-red-800 text-red-300'
              }`}
            >
              <span>{syncMessage.text}</span>
              <button
                onClick={() => setSyncMessage(null)}
                className="text-zinc-400 hover:text-white text-xs cursor-pointer ml-4"
              >
                ✕
              </button>
            </div>
          )}
        </div>

        {/* Section 1: Style-to-Narrator Defaults (Admin Section) */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 sm:p-8 shadow-xl space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-zinc-800">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base">🎯</span>
                <h2 className="text-xl font-bold text-white tracking-tight">
                  Style-to-Narrator Defaults
                </h2>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                Pre-assign default narrator voices to each video genre. Approved scripts automatically select their genre default without manual selection every time.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {VIDEO_STYLES.map((style) => {
              const currentNarratorId = styleDefaults[style.key] || '';
              const isSaving = savingStyle === style.key;

              return (
                <div
                  key={style.key}
                  className="p-4 rounded-2xl bg-zinc-950/70 border border-zinc-800 hover:border-zinc-700 transition flex flex-col justify-between space-y-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-lg">{style.icon}</span>
                      <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                        {style.key}
                      </span>
                    </div>
                    <h3 className="text-sm font-bold text-white">{style.label}</h3>
                    <p className="text-[11px] text-zinc-400 line-clamp-2">{style.description}</p>
                  </div>

                  <div className="space-y-1 pt-2 border-t border-zinc-900">
                    <label className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block">
                      Default Narrator:
                    </label>
                    <select
                      value={currentNarratorId}
                      disabled={isSaving}
                      onChange={(e) => handleUpdateDefault(style.key, e.target.value)}
                      className="w-full px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500 cursor-pointer disabled:opacity-50"
                    >
                      <option value="">— None (Manual Picker) —</option>
                      {narrators.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name} ({n.yt_provider_configs?.label?.slice(0, 15) || n.provider_slug || 'TTS'})
                        </option>
                      ))}
                    </select>
                    {isSaving && (
                      <span className="text-[10px] text-amber-400 flex items-center gap-1 animate-pulse">
                        Saving default...
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Section 2: Narrator Roster Grouped by Provider */}
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="text-base">🎙️</span>
              <h2 className="text-xl font-bold text-white tracking-tight">
                Synced Narrator Roster
              </h2>
            </div>

            {/* Filter Search Input */}
            <div className="relative w-full sm:w-72">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search voices, ID, or tier..."
                className="w-full pl-9 pr-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500 transition"
              />
              <svg
                className="w-4 h-4 text-zinc-500 absolute left-3 top-2.5 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>

          {loading ? (
            <div className="p-16 text-center bg-zinc-900 border border-zinc-800 rounded-3xl space-y-3">
              <div className="w-8 h-8 border-3 border-zinc-700 border-t-red-500 rounded-full animate-spin mx-auto" />
              <p className="text-xs text-zinc-400">Loading synced narrators from database...</p>
            </div>
          ) : narrators.length === 0 ? (
            <div className="p-16 text-center bg-zinc-900 border border-zinc-800 rounded-3xl space-y-4">
              <div className="w-16 h-16 rounded-full bg-zinc-800/80 border border-zinc-700/50 flex items-center justify-center text-3xl mx-auto">
                🎙️
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-white">No Narrators Synced Yet</h3>
                <p className="text-xs text-zinc-400 max-w-md mx-auto">
                  Click the sync button below to query active TTS providers (Kokoro local or ElevenLabs) and populate available voices.
                </p>
              </div>
              <div>
                <button
                  onClick={() => handleSync()}
                  disabled={syncingAll}
                  className="px-6 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-xs shadow-lg shadow-red-600/25 transition cursor-pointer"
                >
                  {syncingAll ? 'Syncing...' : 'Sync Voices Now'}
                </button>
              </div>
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="p-12 text-center bg-zinc-900 border border-zinc-800 rounded-2xl text-xs text-zinc-400">
              No voices matched "{searchQuery}".
            </div>
          ) : (
            filteredGroups.map((group) => {
              const isSyncingThis = syncingProviderId === group.providerId;

              return (
                <div
                  key={group.providerId}
                  className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 sm:p-8 shadow-xl space-y-6"
                >
                  {/* Provider Header */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-zinc-800">
                    <div className="space-y-1">
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-bold text-white tracking-tight">
                          {group.label}
                        </h3>
                        <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono uppercase bg-zinc-800 border border-zinc-700 text-zinc-300">
                          {group.providerSlug}
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          Active
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400">
                        {group.items.length} {group.items.length === 1 ? 'voice' : 'voices'} available
                      </p>
                    </div>

                    <div>
                      {group.providerId !== 'unassigned' && (
                        <button
                          onClick={() => handleSync(group.providerId)}
                          disabled={isSyncingThis || syncingAll}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-900 text-zinc-200 border border-zinc-700 text-xs font-medium transition cursor-pointer disabled:opacity-50"
                        >
                          {isSyncingThis ? (
                            <>
                              <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              <span>Syncing...</span>
                            </>
                          ) : (
                            <>
                              <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                              <span>Sync Provider</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Voice Cards Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {group.items.map((narrator) => (
                      <div
                        key={narrator.id}
                        className="p-4 rounded-2xl bg-zinc-950/70 border border-zinc-800/80 hover:border-zinc-700 transition flex flex-col justify-between space-y-3 group"
                      >
                        <div className="space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <h4 className="text-sm font-bold text-white group-hover:text-red-400 transition-colors">
                                {narrator.name}
                              </h4>
                              <span className="text-[11px] font-mono text-zinc-500">
                                {narrator.voice_id}
                              </span>
                            </div>
                            {getTierBadge(narrator.tier)}
                          </div>
                        </div>

                        {/* Audio Preview or Local Engine badge */}
                        <div className="pt-2 border-t border-zinc-900">
                          {narrator.sample_url ? (
                            <div className="space-y-1">
                              <span className="text-[10px] text-zinc-400 block font-medium">Sample Preview:</span>
                              <audio
                                controls
                                preload="none"
                                src={narrator.sample_url}
                                className="w-full h-8 text-xs accent-red-500 rounded bg-zinc-900"
                              />
                            </div>
                          ) : (
                            <div className="flex items-center justify-between text-[11px] text-zinc-400 bg-zinc-900/60 px-3 py-1.5 rounded-lg border border-zinc-800/50">
                              <span className="flex items-center gap-1.5 text-zinc-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                {voiceSourceLabel(narrator.yt_provider_configs?.provider || narrator.provider_slug)}
                              </span>
                              <span className="text-[10px] text-zinc-500 font-mono">Ready</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <PronunciationEditor />
      </div>
    </div>
  );
}
