'use client';

import React, { useEffect, useState, useRef, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import BatchVisualUploader from './batch-uploader';
import { VoiceCheckBadge, VoiceCheckPanel, type BeatVoiceCheck } from './voice-check-panel';
import { ShotEditor } from './shot-editor';
import { RhythmPanel } from './rhythm-panel';
import { NeedsCheckBar } from './needs-check-bar';
import type { MediaCandidate } from '@/pipeline/visuals/types';

interface VisualsPageProps {
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
  end_offset_seconds?: number | null;
  candidates_json?: MediaCandidate[] | null;
  created_at?: string;
}

interface JobUnit {
  stage: string;
  unit_index: number;
  status: string;
  duration_ms: number | null;
}

interface ProgressData {
  video: {
    id: string;
    title: string | null;
    status: string;
    script_json?: {
      beats?: ScriptBeat[];
    } | null;
  };
  job: {
    id: string;
  } | null;
  units: JobUnit[];
  assets: VideoAsset[];
}

const LICENSE_OPTIONS = [
  { value: 'own_work', label: 'Own Work / Original Footage' },
  { value: 'purchased', label: 'Purchased / Commercial License' },
  { value: 'royalty_free', label: 'Royalty-Free' },
  { value: 'public_domain', label: 'Public Domain' },
  { value: 'cc0', label: 'Creative Commons Zero (CC0)' },
  { value: 'cc_by', label: 'Creative Commons Attribution (CC-BY)' },
  { value: 'cc_by_sa', label: 'Creative Commons Attribution-ShareAlike (CC BY-SA)' },
];

export default function BeatVisualsPage({ params }: VisualsPageProps) {
  const resolvedParams = use(params);
  const id = resolvedParams.id;
  const router = useRouter();

  const [data, setData] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-beat form states
  const [uploadFiles, setUploadFiles] = useState<Record<number, File | null>>({});
  const [licenseTypes, setLicenseTypes] = useState<Record<number, string>>({});
  const [sourceNotes, setSourceNotes] = useState<Record<number, string>>({});
  const [attributionTexts, setAttributionTexts] = useState<Record<number, string>>({});
  const [uploadingBeat, setUploadingBeat] = useState<number | null>(null);
  const [beatErrors, setBeatErrors] = useState<Record<number, string>>({});
  const [beatWarnings, setBeatWarnings] = useState<Record<number, string[]>>({});
  const [cacheBuster, setCacheBuster] = useState<number>(Date.now());
  const [voiceChecks, setVoiceChecks] = useState<Map<number, BeatVoiceCheck>>(new Map());

  // Video Trim Offsets state
  const [trimOffsets, setTrimOffsets] = useState<Record<number, number>>({});
  const [savingTrim, setSavingTrim] = useState<Record<number, boolean>>({});
  const [savedTrimSuccess, setSavedTrimSuccess] = useState<Record<number, boolean>>({});

  // Assembly trigger state
  const [isAssembling, setIsAssembling] = useState(false);
  const [assemblyError, setAssemblyError] = useState<string | null>(null);

  // Background Music (Auto-Ducked) state
  const [bgmEnabled, setBgmEnabled] = useState(true);
  const [bgmTrack, setBgmTrack] = useState('story');
  const [bgmVolume, setBgmVolume] = useState(0.2);
  const [previewingTrack, setPreviewingTrack] = useState<string | null>(null);
  const [savingBgm, setSavingBgm] = useState(false);
  const [padStyle, setPadStyle] = useState<'blur' | 'black'>('blur');
  const [stillMotion, setStillMotion] = useState<'zoom' | 'static'>('zoom');
  const [transition, setTransition] = useState<string>('cut');
  // Style-matched transitions: how often and how big
  const [transitionIntensity, setTransitionIntensity] = useState<'subtle' | 'balanced' | 'bold'>('balanced');
  const [transitionRendered, setTransitionRendered] = useState(true);

  // Transition Sound Effects (SFX) state
  const [sfxEnabled, setSfxEnabled] = useState(true);
  const [sfxTrack, setSfxTrack] = useState('smart');
  const [sfxVolume, setSfxVolume] = useState(0.25);
  // Real sounds on the words that describe them, and the moments last planned
  const [narrationSounds, setNarrationSounds] = useState(true);
  const [soundMoments, setSoundMoments] = useState<Array<{ beat_index: number; trigger: string; sound: string }> | null>(null);
  const [soundBeds, setSoundBeds] = useState<Array<{ start_beat: number; end_beat: number; sound: string }> | null>(null);
  const [paletteSounds, setPaletteSounds] = useState(true);
  // Music swells into reveals, drops out before key lines, and stings at chapter changes
  const [musicAccents, setMusicAccents] = useState(true);
  const [previewingSfx, setPreviewingSfx] = useState<string | null>(null);

  // Beat Pacing & Breathing Room state (default 0.5s pause)
  const [beatPauseSeconds, setBeatPauseSeconds] = useState(0.5);

  // Kinetic captions burned into the final render ('none' = off)
  const [captionPreset, setCaptionPreset] = useState<string>('none');
  // The style's colour grade at mastering ('auto') or none ('off', faster to render)
  const [filmLook, setFilmLook] = useState<'auto' | 'off'>('auto');
  const [archiveLook, setArchiveLook] = useState<'auto' | 'off'>('auto');
  const [emphasisEnabled, setEmphasisEnabled] = useState(true);
  const [letterbox, setLetterbox] = useState<'auto' | 'on' | 'off'>('auto');

  // Batch Uploader state
  const [showBatchUploader, setShowBatchUploader] = useState(false);

  // Media Candidate Swapping & Ad-hoc Search state
  const [swappingBeat, setSwappingBeat] = useState<number | null>(null);
  const [searchQueries, setSearchQueries] = useState<Record<number, string>>({});
  const [searchingBeat, setSearchingBeat] = useState<number | null>(null);
  const [customCandidates, setCustomCandidates] = useState<Record<number, MediaCandidate[]>>({});

  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const sfxAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (bgmAudioRef.current) {
        bgmAudioRef.current.pause();
        bgmAudioRef.current = null;
      }
      if (sfxAudioRef.current) {
        sfxAudioRef.current.pause();
        sfxAudioRef.current = null;
      }
    };
  }, []);

  // Retrieve remembered license
  function getLastLicenseChoice(): string {
    if (typeof window !== 'undefined') {
      // A remembered choice that's no longer offered (e.g. the old Fair Use option) falls back to Own Work
      const saved = localStorage.getItem('yt_last_license_choice');
      return saved && LICENSE_OPTIONS.some((o) => o.value === saved) ? saved : 'own_work';
    }
    return 'own_work';
  }

  function setLastLicenseChoice(val: string) {
    if (typeof window !== 'undefined') {
      localStorage.setItem('yt_last_license_choice', val);
    }
  }

  async function handleSwapCandidate(beatIndex: number, candidate: MediaCandidate) {
    try {
      setSwappingBeat(beatIndex);
      const res = await fetch(`/api/videos/${id}/beats/${beatIndex}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to swap candidate');
      }
      setCacheBuster(Date.now());
      await fetchVideoData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Swap failed');
    } finally {
      setSwappingBeat(null);
    }
  }

  async function handleSearchCandidates(beatIndex: number) {
    const query = searchQueries[beatIndex]?.trim();
    if (!query) return;
    try {
      setSearchingBeat(beatIndex);
      const res = await fetch(`/api/videos/${id}/beats/${beatIndex}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const resData = await res.json();
      if (resData.candidates) {
        setCustomCandidates((prev) => ({ ...prev, [beatIndex]: resData.candidates }));
      }
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setSearchingBeat(null);
    }
  }

  async function updateBgmConfig(updates: {
    enabled?: boolean;
    track?: string;
    volume?: number;
    padStyle?: 'blur' | 'black';
    stillMotion?: 'zoom' | 'static';
    transition?: string;
    sfxEnabled?: boolean;
    sfxTrack?: string;
    sfxVolume?: number;
    sfxNarration?: boolean;
    sfxPalette?: boolean;
    musicAccents?: boolean;
    beatPauseSeconds?: number;
    captionPreset?: string;
    look?: 'auto' | 'off';
    archiveLook?: 'auto' | 'off';
    transitionIntensity?: 'subtle' | 'balanced' | 'bold';
    transitionRendered?: boolean;
    emphasisEnabled?: boolean;
    letterbox?: 'auto' | 'on' | 'off';
  }) {
    const nextEnabled = updates.enabled !== undefined ? updates.enabled : bgmEnabled;
    const nextTrack = updates.track !== undefined ? updates.track : bgmTrack;
    const nextVolume = updates.volume !== undefined ? updates.volume : bgmVolume;
    const nextPadStyle = updates.padStyle !== undefined ? updates.padStyle : padStyle;
    const nextStillMotion = updates.stillMotion !== undefined ? updates.stillMotion : stillMotion;
    const nextTransition = updates.transition !== undefined ? updates.transition : transition;
    const nextIntensity = updates.transitionIntensity !== undefined ? updates.transitionIntensity : transitionIntensity;
    setTransitionIntensity(nextIntensity);
    const nextRendered = updates.transitionRendered !== undefined ? updates.transitionRendered : transitionRendered;
    setTransitionRendered(nextRendered);
    const nextSfxEnabled = updates.sfxEnabled !== undefined ? updates.sfxEnabled : sfxEnabled;
    const nextSfxTrack = updates.sfxTrack !== undefined ? updates.sfxTrack : sfxTrack;
    const nextSfxVolume = updates.sfxVolume !== undefined ? updates.sfxVolume : sfxVolume;
    const nextSfxNarration = updates.sfxNarration !== undefined ? updates.sfxNarration : narrationSounds;
    const nextSfxPalette = updates.sfxPalette !== undefined ? updates.sfxPalette : paletteSounds;
    const nextMusicAccents = updates.musicAccents !== undefined ? updates.musicAccents : musicAccents;
    const nextBeatPause =
      updates.beatPauseSeconds !== undefined ? updates.beatPauseSeconds : beatPauseSeconds;
    const nextCaptionPreset =
      updates.captionPreset !== undefined ? updates.captionPreset : captionPreset;
    const nextLook = updates.look !== undefined ? updates.look : filmLook;
    const nextArchiveLook = updates.archiveLook !== undefined ? updates.archiveLook : archiveLook;
    const nextEmphasis = updates.emphasisEnabled !== undefined ? updates.emphasisEnabled : emphasisEnabled;
    const nextLetterbox = updates.letterbox !== undefined ? updates.letterbox : letterbox;
    setEmphasisEnabled(nextEmphasis);
    setLetterbox(nextLetterbox);

    setBgmEnabled(nextEnabled);
    setBgmTrack(nextTrack);
    setBgmVolume(nextVolume);
    setPadStyle(nextPadStyle);
    setStillMotion(nextStillMotion);
    setTransition(nextTransition);
    setSfxEnabled(nextSfxEnabled);
    setSfxTrack(nextSfxTrack);
    setSfxVolume(nextSfxVolume);
    setNarrationSounds(nextSfxNarration);
    setPaletteSounds(nextSfxPalette);
    setMusicAccents(nextMusicAccents);
    setBeatPauseSeconds(nextBeatPause);
    setCaptionPreset(nextCaptionPreset);
    setFilmLook(nextLook);
    setArchiveLook(nextArchiveLook);

    try {
      setSavingBgm(true);
      await fetch(`/api/videos/${id}/bgm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: nextEnabled,
          track: nextTrack,
          volume: nextVolume,
          padStyle: nextPadStyle,
          stillMotion: nextStillMotion,
          transition: nextTransition,
          transitionIntensity: nextIntensity,
          transitionRendered: nextRendered,
          sfxEnabled: nextSfxEnabled,
          sfxTrack: nextSfxTrack,
          sfxVolume: nextSfxVolume,
          sfxNarration: nextSfxNarration,
          sfxPalette: nextSfxPalette,
          musicAccents: nextMusicAccents,
          beatPauseSeconds: nextBeatPause,
          captionPreset: nextCaptionPreset,
          look: nextLook,
          archiveLook: nextArchiveLook,
          emphasisEnabled: nextEmphasis,
          letterbox: nextLetterbox,
        }),
      });
    } catch (err) {
      console.warn('Failed to save BGM, SFX & framing settings:', err);
    } finally {
      setSavingBgm(false);
    }
  }

  function togglePreviewSfx(trackId: string) {
    if (previewingSfx === trackId) {
      sfxAudioRef.current?.pause();
      setPreviewingSfx(null);
    } else {
      if (sfxAudioRef.current) {
        sfxAudioRef.current.pause();
      }
      const audio = new Audio(`/api/sfx/presets/${trackId}`);
      audio.volume = Math.min(1.0, sfxVolume * 2);
      audio.onended = () => setPreviewingSfx(null);
      sfxAudioRef.current = audio;
      audio.play().catch(() => {});
      setPreviewingSfx(trackId);
    }
  }

  function togglePreviewTrack(trackId: string) {
    if (previewingTrack === trackId) {
      bgmAudioRef.current?.pause();
      setPreviewingTrack(null);
    } else {
      if (bgmAudioRef.current) {
        bgmAudioRef.current.pause();
      }
      const audio = new Audio(`/api/bgm/presets/${trackId}`);
      audio.volume = Math.min(1.0, bgmVolume * 2);
      audio.onended = () => setPreviewingTrack(null);
      bgmAudioRef.current = audio;
      audio.play().catch(() => {});
      setPreviewingTrack(trackId);
    }
  }

  async function fetchVideoData() {
    try {
      const res = await fetch(`/api/videos/${id}/progress`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `Failed to fetch video data (${res.status})`);
      }
      const json: ProgressData = await res.json();
      setData(json);

      // Fetch BGM & Framing settings
      fetch(`/api/videos/${id}/bgm`)
        .then((r) => r.json())
        .then((bData) => {
          if (bData.bgm) {
            setBgmEnabled(bData.bgm.enabled !== false);
            setBgmTrack(bData.bgm.track || 'story');
            setBgmVolume(Number(bData.bgm.volume ?? 0.2));
            setMusicAccents(bData.bgm.accents !== false);
          }
          if (bData.padStyle) {
            setPadStyle(bData.padStyle);
          }
          if (bData.stillMotion) {
            setStillMotion(bData.stillMotion);
          }
          if (bData.transition) {
            setTransition(bData.transition);
          }
          if (bData.transitionRendered !== undefined) setTransitionRendered(bData.transitionRendered !== false);
          if (['subtle', 'balanced', 'bold'].includes(bData.transitionIntensity)) {
            setTransitionIntensity(bData.transitionIntensity);
          }
          if (bData.sfx) {
            setSfxEnabled(bData.sfx.enabled !== false);
            setSfxTrack(bData.sfx.track || 'smart');
            setSfxVolume(Number(bData.sfx.volume ?? 0.25));
            setNarrationSounds(bData.sfx.narration !== false);
            setPaletteSounds(bData.sfx.palette !== false);
          }
          setSoundMoments(Array.isArray(bData.soundMoments) ? bData.soundMoments : null);
          setSoundBeds(Array.isArray(bData.soundBeds) ? bData.soundBeds : null);
          if (bData.beatPauseSeconds !== undefined) {
            setBeatPauseSeconds(Number(bData.beatPauseSeconds));
          }
          if (bData.look === 'off' || bData.look === 'auto') {
            setFilmLook(bData.look);
          }
          if (bData.emphasis) {
            setEmphasisEnabled(bData.emphasis.enabled !== false);
            if (['auto', 'on', 'off'].includes(bData.emphasis.letterbox)) setLetterbox(bData.emphasis.letterbox);
          }
          if (bData.archiveLook === 'off' || bData.archiveLook === 'auto') {
            setArchiveLook(bData.archiveLook);
          }
          if (bData.captionPreset) {
            setCaptionPreset(bData.captionPreset);
          }
        })
        .catch(() => {});

      // Initialize license choice for beats not yet populated
      const initialLicenses: Record<number, string> = {};
      const initialNotes: Record<number, string> = {};
      const initialAttributions: Record<number, string> = {};
      const initialTrimOffsets: Record<number, number> = {};

      json.assets?.forEach((asset) => {
        if (asset.license_type) {
          initialLicenses[asset.beat_index] = asset.license_type;
        }
        if (asset.source_url) {
          initialNotes[asset.beat_index] = asset.source_url;
        }
        if (asset.attribution_text) {
          initialAttributions[asset.beat_index] = asset.attribution_text;
        }
        if (asset.start_offset_seconds != null) {
          initialTrimOffsets[asset.beat_index] = Number(asset.start_offset_seconds);
        }
      });

      setTrimOffsets((prev) => ({
        ...initialTrimOffsets,
        ...prev,
      }));
      setLicenseTypes((prev) => ({
        ...prev,
        ...initialLicenses,
      }));
      setSourceNotes((prev) => ({
        ...prev,
        ...initialNotes,
      }));
      setAttributionTexts((prev) => ({
        ...prev,
        ...initialAttributions,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error fetching video data');
    } finally {
      setLoading(false);
    }
  }

  function handleSeekBeatVideo(beatIndex: number, seconds: number) {
    const video = document.getElementById(`beat-video-${beatIndex}`) as HTMLVideoElement | null;
    if (video) {
      video.currentTime = seconds;
      video.play().catch(() => {});
    }
  }

  async function handleSaveTrim(beatIndex: number) {
    const offset = trimOffsets[beatIndex] ?? 0;
    setSavingTrim((prev) => ({ ...prev, [beatIndex]: true }));
    try {
      const res = await fetch(`/api/videos/${id}/beats/${beatIndex}/visual`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_offset_seconds: offset }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to save trim');
      }
      setSavedTrimSuccess((prev) => ({ ...prev, [beatIndex]: true }));
      setTimeout(() => {
        setSavedTrimSuccess((prev) => ({ ...prev, [beatIndex]: false }));
      }, 2500);
      await fetchVideoData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error saving trim offset');
    } finally {
      setSavingTrim((prev) => ({ ...prev, [beatIndex]: false }));
    }
  }

  useEffect(() => {
    fetchVideoData();
  }, [id]);

  const beats: ScriptBeat[] = data?.video?.script_json?.beats || [];
  const assets: VideoAsset[] = data?.assets || [];
  const ttsUnits = (data?.units || []).filter((u) => u.stage === 'tts');

  // Map of beat_index -> asset
  const assetMap = new Map<number, VideoAsset>();
  assets.forEach((a) => assetMap.set(a.beat_index, a));

  // Map of beat_index -> tts unit
  const ttsUnitMap = new Map<number, JobUnit>();
  ttsUnits.forEach((u) => ttsUnitMap.set(u.unit_index, u));

  // Count beats with visuals
  const beatsWithVisualsCount = beats.filter((_, idx) => assetMap.has(idx)).length;
  const allBeatsHaveVisuals = beats.length > 0 && beatsWithVisualsCount === beats.length;

  async function handleUpload(beatIndex: number) {
    const file = uploadFiles[beatIndex];
    if (!file) {
      setBeatErrors((prev) => ({ ...prev, [beatIndex]: 'Please choose a file to upload.' }));
      return;
    }

    const license = licenseTypes[beatIndex] || getLastLicenseChoice();
    const sourceNote = sourceNotes[beatIndex] || '';
    const attribution = attributionTexts[beatIndex] || '';

    if ((license === 'cc_by' || license === 'cc_by_sa') && !attribution.trim()) {
      setBeatErrors((prev) => ({
        ...prev,
        [beatIndex]: 'Attribution text is required for CC-BY and CC BY-SA licenses.',
      }));
      return;
    }

    setUploadingBeat(beatIndex);
    setBeatErrors((prev) => ({ ...prev, [beatIndex]: '' }));
    setBeatWarnings((prev) => ({ ...prev, [beatIndex]: [] }));

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('license_type', license);
      if (sourceNote.trim()) formData.append('source_note', sourceNote.trim());
      if (attribution.trim()) formData.append('attribution_text', attribution.trim());
      if (trimOffsets[beatIndex] != null && trimOffsets[beatIndex] > 0) {
        formData.append('start_offset_seconds', String(trimOffsets[beatIndex]));
      }

      const res = await fetch(`/api/videos/${id}/beats/${beatIndex}/visual`, {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `Upload failed (HTTP ${res.status})`);
      }

      // Remember last license choice
      setLastLicenseChoice(license);

      // Display warnings if any
      if (json.warnings && json.warnings.length > 0) {
        setBeatWarnings((prev) => ({ ...prev, [beatIndex]: json.warnings }));
      }

      // Clear selected file input state and refresh cache
      setUploadFiles((prev) => ({ ...prev, [beatIndex]: null }));
      setCacheBuster(Date.now());
      await fetchVideoData();
    } catch (err) {
      setBeatErrors((prev) => ({
        ...prev,
        [beatIndex]: err instanceof Error ? err.message : 'Upload failed',
      }));
    } finally {
      setUploadingBeat(null);
    }
  }

  async function handleStartAssembly() {
    setIsAssembling(true);
    setAssemblyError(null);
    try {
      const res = await fetch(`/api/videos/${id}/assembly`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `Assembly request failed (${res.status})`);
      }
      router.push(`/videos/${id}/progress`);
    } catch (err) {
      setAssemblyError(err instanceof Error ? err.message : 'Failed to start assembly');
    } finally {
      setIsAssembling(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6 font-sans">
        <div className="flex items-center gap-3 text-zinc-400">
          <div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-200 rounded-full animate-spin" />
          <span>Loading beat visuals...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-4xl mx-auto font-sans">
        <div className="bg-red-950/40 border border-red-800 rounded-xl p-6 text-red-200">
          <h2 className="text-lg font-semibold mb-2">Error Loading Visuals</h2>
          <p>{error || 'Video not found'}</p>
          <Link
            href={`/videos/${id}/progress`}
            className="inline-block mt-4 text-sm text-red-300 hover:text-red-100 underline"
          >
            ← Back to Progress
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 md:p-10 font-sans">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-sm text-zinc-400">
            <Link
              href={`/videos/${id}/review`}
              className="hover:text-zinc-200 transition-colors flex items-center gap-1"
            >
              ← Script Review
            </Link>
            <span>/</span>
            <Link
              href={`/videos/${id}/progress`}
              className="hover:text-zinc-200 transition-colors flex items-center gap-1"
            >
              Progress
            </Link>
            <span>/</span>
            <Link
              href={`/videos/${id}/vibedit`}
              className="px-2 py-0.5 rounded-md bg-indigo-950 border border-indigo-700/60 text-indigo-300 hover:text-white hover:bg-indigo-900 transition flex items-center gap-1 text-xs font-semibold"
            >
              <span>🎬</span>
              <span>Vibedit Studio</span>
            </Link>
          </div>
          <button
            onClick={() => fetchVideoData()}
            className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition"
          >
            Refresh
          </button>
        </div>

        {/* Page Header Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-zinc-800 text-zinc-300">
                  Manual Visuals
                </span>
                <span
                  className={`px-3 py-0.5 rounded-full text-xs font-semibold ${
                    allBeatsHaveVisuals
                      ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700'
                      : 'bg-amber-900/40 text-amber-300 border border-amber-700'
                  }`}
                >
                  {beatsWithVisualsCount} of {beats.length} beats have visuals
                </span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
                {data.video.title || 'Video Visuals'}
              </h1>
              <p className="text-sm text-zinc-400 mt-1">
                Beats you don&apos;t upload for are auto-generated (chart, map, newspaper, archive, stock) from their visual type during voicing. Upload only to override one. Accepted formats: MP4, MOV, WebM, PNG, JPG, WebP.
              </p>
            </div>

            {/* Assemble Gate & Batch Actions */}
            <div className="flex flex-col sm:flex-row items-end sm:items-center gap-3">
              <button
                type="button"
                onClick={() => setShowBatchUploader((prev) => !prev)}
                className="px-4 py-2.5 rounded-xl font-bold text-xs transition shadow-lg bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-850 text-indigo-300 border border-indigo-500/30 hover:border-indigo-500/60 flex items-center gap-2 cursor-pointer"
              >
                <span>🚀</span>
                <span>{showBatchUploader ? 'Hide Batch Uploader' : 'Batch Upload Visuals'}</span>
              </button>

              <div className="flex flex-col items-end gap-1">
                <button
                  onClick={handleStartAssembly}
                  disabled={isAssembling || !allBeatsHaveVisuals}
                  className={`px-5 py-2.5 rounded-xl font-medium text-sm transition shadow-lg ${
                    allBeatsHaveVisuals
                      ? 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer shadow-indigo-500/20'
                      : 'bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700'
                  }`}
                  title={
                    !allBeatsHaveVisuals
                      ? `Cannot assemble: ${beats.length - beatsWithVisualsCount} beats missing visuals`
                      : 'Proceed to Video Assembly'
                  }
                >
                  {isAssembling ? 'Starting Assembly...' : 'Assemble Video →'}
                </button>
              </div>
            </div>
          </div>

          {assemblyError && (
            <div className="mt-4 p-3 rounded-lg bg-red-950/50 border border-red-800 text-xs text-red-200">
              {assemblyError}
            </div>
          )}
        </div>

        {/* Batch Visuals Uploader Drawer / Card */}
        {showBatchUploader && (
          <BatchVisualUploader
            videoId={id}
            totalBeats={beats.length}
            beats={beats}
            existingAssetBeatIndices={new Set(assets.map((a) => a.beat_index))}
            onBeatUploaded={() => {
              setCacheBuster(Date.now());
              fetchVideoData();
            }}
            onBatchComplete={() => {
              setCacheBuster(Date.now());
              fetchVideoData();
            }}
            onClose={() => setShowBatchUploader(false)}
          />
        )}

        {/* Background Music & Auto-Ducking Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-white flex items-center gap-2">
                  <span>🎵</span> Background Music & Auto-Ducking
                </span>
                {savingBgm && (
                  <span className="text-[11px] text-zinc-400 animate-pulse font-mono">
                    Saving...
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                Subtle music plays behind your narration and automatically ducks (attenuates) when the voice speaks.
              </p>
            </div>

            {/* Enable/Disable Toggle */}
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-zinc-300">
                {bgmEnabled && bgmTrack !== 'none' ? 'BGM Active' : 'Voice Only'}
              </span>
              <button
                type="button"
                onClick={() => updateBgmConfig({ enabled: !bgmEnabled })}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                  bgmEnabled && bgmTrack !== 'none' ? 'bg-indigo-600' : 'bg-zinc-800 border border-zinc-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    bgmEnabled && bgmTrack !== 'none' ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>

          {bgmEnabled && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 pt-3 border-t border-zinc-800/80">
              {/* Track Selector */}
              <div className="md:col-span-2 space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Select Music Mood
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {[
                    { id: 'story', label: 'Story-matched (mood per chapter)', icon: '🎼' },
                    { id: 'lofi', label: 'Chill Lo-Fi', icon: '☕' },
                    { id: 'ambient', label: 'Cinematic Ambient', icon: '🌌' },
                    { id: 'tech', label: 'Modern Tech', icon: '💻' },
                    { id: 'none', label: 'None (Silent)', icon: '🚫' },
                  ].map((preset) => {
                    const isSelected = bgmTrack === preset.id;
                    const isPlaying = previewingTrack === preset.id;

                    return (
                      <div
                        key={preset.id}
                        className={`relative p-3 rounded-xl border flex flex-col justify-between transition cursor-pointer ${
                          isSelected
                            ? 'bg-indigo-950/40 border-indigo-500/80 text-white shadow-md shadow-indigo-950'
                            : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                        }`}
                        onClick={() => updateBgmConfig({ track: preset.id })}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-base">{preset.icon}</span>
                          {preset.id !== 'none' && preset.id !== 'story' && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePreviewTrack(preset.id);
                              }}
                              className={`p-1 rounded-full text-[10px] transition ${
                                isPlaying
                                  ? 'bg-emerald-500 text-black font-bold animate-pulse'
                                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
                              }`}
                              title={isPlaying ? 'Stop Preview' : 'Listen Preview'}
                            >
                              {isPlaying ? '⏹' : '▶'}
                            </button>
                          )}
                        </div>
                        <span className="text-xs font-medium mt-2 leading-tight">
                          {preset.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Volume & Ducking Level */}
              <div className="space-y-2 bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/80 flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    BGM Volume
                  </label>
                  <span className="text-xs font-mono font-bold text-indigo-400">
                    {Math.round(bgmVolume * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="0.45"
                  step="0.01"
                  value={bgmVolume}
                  onChange={(e) => updateBgmConfig({ volume: parseFloat(e.target.value) })}
                  className="w-full accent-indigo-500 cursor-pointer"
                />
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span>Subtle (10%)</span>
                  <span>Balanced (20%)</span>
                  <span>Prominent (40%)</span>
                </div>
                <p className="text-[11px] text-zinc-400 pt-1 border-t border-zinc-800/60">
                  ⚡ Auto-ducks by -16dB whenever voice speaks.
                </p>
                <label className="flex items-start gap-2 pt-2 text-[11px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={musicAccents}
                    onChange={(e) => updateBgmConfig({ musicAccents: e.target.checked })}
                    className="accent-indigo-500 mt-0.5"
                  />
                  <span>
                    <span className="text-zinc-200 font-semibold">Music hits moments</span>
                    <span className="text-zinc-500"> · swells into reveals, goes silent before key lines, a sting at each chapter change</span>
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* Canvas Framing for Non-16:9 Media */}
          <div className="pt-4 border-t border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Framing for Non-16:9 Media (Vertical, 4:3, Square)
              </span>
              <p className="text-[11px] text-zinc-400">
                {padStyle === 'blur'
                  ? 'Gaussian-blurred duplicate background fills empty canvas space (Broadcast aesthetic).'
                  : 'Classic letterbox/pillarbox solid black bars.'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => updateBgmConfig({ padStyle: 'blur' })}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                  padStyle === 'blur'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span>🎨</span> Blurred Background
              </button>
              <button
                type="button"
                onClick={() => updateBgmConfig({ padStyle: 'black' })}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                  padStyle === 'black'
                    ? 'bg-zinc-700 text-white shadow-md'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span>⬛</span> Black Bars
              </button>
            </div>
          </div>

          {/* Still Image Motion (Ken Burns Effect) */}
          <div className="pt-4 border-t border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Still Image Motion (Ken Burns Effect)
              </span>
              <p className="text-[11px] text-zinc-400">
                {stillMotion === 'zoom'
                  ? 'Subtle cinematic slow zoom motion on still photos and graphics to prevent static dead spots.'
                  : 'Locked static frame (ideal for technical schematics, code snippets, or text slides).'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => updateBgmConfig({ stillMotion: 'zoom' })}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                  stillMotion === 'zoom'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span>🎬</span> Ken Burns Zoom
              </button>
              <button
                type="button"
                onClick={() => updateBgmConfig({ stillMotion: 'static' })}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                  stillMotion === 'static'
                    ? 'bg-zinc-700 text-white shadow-md'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span>⏹</span> Static Frame
              </button>
            </div>
          </div>

          {/* Scene-to-Scene Transitions */}
          <div className="pt-4 border-t border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Scene-to-Scene Transitions
              </span>
              <p className="text-[11px] text-zinc-400">
                {transition === 'cut' &&
                  'Instant cut between beats. Clean, fast-paced, and recommended for commentary & tech.'}
                {transition === 'dip_black' &&
                  'Smooth 0.35s fade through black. Cinematic documentary aesthetic with perfect narration sync.'}
                {transition === 'dip_white' &&
                  'High-impact 0.20s flash to white between beats. Modern, energetic commercial style.'}
                {transition === 'crossfade' &&
                  'Gentle dissolve crossfading adjacent scenes directly into each other.'}
                {transition === 'wipe' &&
                  'Dynamic horizontal wipe sliding across adjacent scene boundaries.'}
                {transition === 'style' &&
                  'Transitions in this style\'s own language (slides and whips for sport, glitches for tech, fades for history), bigger at chapter changes and into reveals, never fading a spoken word.'}
              </p>
              {transition === 'style' && (
                <div className="flex items-center gap-1.5 mt-2">
                  {(['subtle', 'balanced', 'bold'] as const).map((level) => (
                    <button
                      key={level}
                      type="button"
                      onClick={() => updateBgmConfig({ transitionIntensity: level })}
                      className={`px-2 py-1 rounded-md text-[11px] capitalize cursor-pointer ${
                        transitionIntensity === level ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              )}
              {transition === 'style' && (
                <label className="flex items-start gap-2 mt-2 text-[11px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={transitionRendered}
                    onChange={(e) => updateBgmConfig({ transitionRendered: e.target.checked })}
                    className="accent-indigo-500 mt-0.5"
                  />
                  <span>
                    <span className="text-zinc-200 font-semibold">Rendered effects at chapter changes and reveals</span>
                    <span className="text-zinc-500"> · film burn, light leak, ink, paper tear, glitch, whip pan, zoom punch, flash. Slow to render: minutes each on a small laptop.</span>
                  </span>
                </label>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { id: 'style', label: 'Style-matched', icon: '🎞️' },
                { id: 'cut', label: 'Cut', icon: '✂️' },
                { id: 'dip_black', label: 'Dip to Black', icon: '🎬' },
                { id: 'dip_white', label: 'Flash White', icon: '⚡' },
                { id: 'crossfade', label: 'Crossfade', icon: '🌫️' },
                { id: 'wipe', label: 'Wipe', icon: '↔️' },
              ].map((tOption) => {
                const isSelected = transition === tOption.id;
                return (
                  <button
                    key={tOption.id}
                    type="button"
                    onClick={() => updateBgmConfig({ transition: tOption.id })}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                      isSelected
                        ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950'
                        : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-750'
                    }`}
                  >
                    <span>{tOption.icon}</span>
                    <span>{tOption.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Transition Sound Effects (SFX) */}
          <div className="pt-4 border-t border-zinc-800/80 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
                  <span>🔊</span> Transition Sound Effects (SFX)
                </span>
                <p className="text-[11px] text-zinc-400">
                  Subtle audio accents (whooshes, swooshes, or tactile clicks) emphasize scene transitions and graphics.
                </p>
              </div>

              {/* SFX Enable/Disable Toggle */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-zinc-400">
                  {sfxEnabled && sfxTrack !== 'none' ? 'SFX Active' : 'SFX Muted'}
                </span>
                <button
                  type="button"
                  onClick={() => updateBgmConfig({ sfxEnabled: !sfxEnabled })}
                  className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors cursor-pointer ${
                    sfxEnabled && sfxTrack !== 'none'
                      ? 'bg-indigo-600'
                      : 'bg-zinc-800 border border-zinc-700'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      sfxEnabled && sfxTrack !== 'none' ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>

            {sfxEnabled && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5 pt-1">
                {/* SFX Preset Selector */}
                <div className="md:col-span-2 space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {[
                      { id: 'smart', label: 'Smart (by what’s on screen)', icon: '🎚️' },
                      { id: 'whoosh', label: 'Whoosh', icon: '💨' },
                      { id: 'swoosh', label: 'Deep Swoosh', icon: '🌊' },
                      { id: 'click', label: 'Tech Click', icon: '🖱️' },
                      { id: 'chime', label: 'Soft Chime', icon: '🔔' },
                      { id: 'none', label: 'None', icon: '🚫' },
                    ].map((preset) => {
                      const isSelected = sfxTrack === preset.id;
                      const isPlaying = previewingSfx === preset.id;

                      return (
                        <div
                          key={preset.id}
                          onClick={() => updateBgmConfig({ sfxTrack: preset.id })}
                          className={`p-2.5 rounded-xl border flex flex-col justify-between transition cursor-pointer ${
                            isSelected
                              ? 'bg-indigo-950/40 border-indigo-500/80 text-white shadow-md shadow-indigo-950'
                              : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-base">{preset.icon}</span>
                            {preset.id !== 'none' && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  togglePreviewSfx(preset.id);
                                }}
                                className={`p-1 rounded-full text-[10px] transition ${
                                  isPlaying
                                    ? 'bg-emerald-500 text-black font-bold animate-pulse'
                                    : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
                                }`}
                                title={isPlaying ? 'Stop Preview' : 'Listen Preview'}
                              >
                                {isPlaying ? '⏹' : '▶'}
                              </button>
                            )}
                          </div>
                          <span className="text-xs font-medium mt-1.5 leading-tight">
                            {preset.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* SFX Volume Slider */}
                <div className="space-y-2 bg-zinc-950/50 p-3.5 rounded-xl border border-zinc-800/80 flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                      SFX Volume
                    </label>
                    <span className="text-xs font-mono font-bold text-indigo-400">
                      {Math.round(sfxVolume * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.05"
                    max="0.50"
                    step="0.01"
                    value={sfxVolume}
                    onChange={(e) =>
                      updateBgmConfig({ sfxVolume: parseFloat(e.target.value) })
                    }
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
                  <div className="flex items-center justify-between text-[11px] text-zinc-500">
                    <span>Subtle (15%)</span>
                    <span>Balanced (25%)</span>
                    <span>Prominent (40%)</span>
                  </div>
                  <p className="text-[10px] text-zinc-400 pt-1 border-t border-zinc-800/60">
                    ⚡ Precision-blended at scene cuts without muffling voiceover.
                  </p>
                </div>
              </div>
            )}
            {sfxEnabled && sfxTrack === 'smart' && (
              <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800 space-y-2 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={narrationSounds}
                    onChange={(e) => updateBgmConfig({ sfxNarration: e.target.checked })}
                    className="accent-indigo-500"
                  />
                  <span className="text-zinc-200 font-semibold">Sounds the narration describes</span>
                  <span className="text-zinc-500">(a gunshot on &quot;fires two shots&quot;, a roar on a goal, and quiet ambience like a stadium or rain)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={paletteSounds}
                    onChange={(e) => updateBgmConfig({ sfxPalette: e.target.checked })}
                    className="accent-indigo-500"
                  />
                  <span className="text-zinc-200 font-semibold">Real recordings for on-screen effects</span>
                  <span className="text-zinc-500">(the style&apos;s own whooshes, clicks and booms instead of the built-in ones)</span>
                </label>
                <p className="text-zinc-500">
                  Planned at assembly and placed on the exact word. Uses your recordings in storage/sfx/real/&lt;sound&gt;/, or CC0 sounds
                  from Freesound when FREESOUND_API_KEY is set; a moment with no recording is skipped.
                </p>
                {narrationSounds && soundMoments && (
                  <p className="text-zinc-400">
                    {soundMoments.length
                      ? `Last planned: ${soundMoments.map((m) => `${m.sound.replace(/_/g, ' ')} on “${m.trigger}” (beat ${m.beat_index + 1})`).join(' · ')}`
                      : 'Last planned: nothing in the narration makes a sound.'}
                    {soundBeds?.length
                      ? ` · Ambience: ${soundBeds.map((b) => `${b.sound.replace(/_bed$/, '').replace(/_/g, ' ')} (beats ${b.start_beat + 1}-${b.end_beat + 1})`).join(', ')}`
                      : ''}
                  </p>
                )}
              </div>
            )}
            {/* Beat Pacing & Breathing Room Section */}
            <div className="pt-5 border-t border-zinc-800/80 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-bold text-white flex items-center gap-2">
                    <span>⏱️</span> Beat Pacing & Breathing Room
                  </span>
                  <p className="text-[11px] text-zinc-400">
                    Adds a natural conversational pause between scenes so the voiceover takes a breath, allowing visuals and background music to breathe.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-bold text-indigo-400 bg-indigo-950/60 border border-indigo-500/30 px-2.5 py-1 rounded-lg">
                    {beatPauseSeconds.toFixed(2)}s pause
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {/* Presets */}
                <div className="md:col-span-2 space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { pause: 0.2, label: 'Fast / Brisk', desc: '0.20s', icon: '⚡' },
                      { pause: 0.5, label: 'Standard (Recommended)', desc: '0.50s', icon: '🎙️' },
                      { pause: 0.8, label: 'Documentary', desc: '0.80s', icon: '🎬' },
                      { pause: 1.2, label: 'Dramatic / Vox', desc: '1.20s', icon: '☕' },
                    ].map((preset) => {
                      const isSelected = Math.abs(beatPauseSeconds - preset.pause) < 0.05;
                      return (
                        <div
                          key={preset.label}
                          onClick={() => updateBgmConfig({ beatPauseSeconds: preset.pause })}
                          className={`p-2.5 rounded-xl border flex flex-col justify-between transition cursor-pointer ${
                            isSelected
                              ? 'bg-indigo-950/40 border-indigo-500/80 text-white shadow-md shadow-indigo-950'
                              : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-base">{preset.icon}</span>
                            <span className="text-[10px] font-mono text-indigo-300 font-bold">{preset.desc}</span>
                          </div>
                          <span className="text-xs font-medium mt-1.5 leading-tight">
                            {preset.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Custom Slider */}
                <div className="space-y-2 bg-zinc-950/50 p-3.5 rounded-xl border border-zinc-800/80 flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                      Custom Pause Duration
                    </label>
                    <span className="text-xs font-mono font-bold text-indigo-400">
                      {beatPauseSeconds.toFixed(2)}s
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.0"
                    max="1.5"
                    step="0.05"
                    value={beatPauseSeconds}
                    onChange={(e) =>
                      updateBgmConfig({ beatPauseSeconds: parseFloat(e.target.value) })
                    }
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
                  <div className="flex items-center justify-between text-[11px] text-zinc-500">
                    <span>Tight (0.0s)</span>
                    <span>Natural (0.5s)</span>
                    <span>Spacious (1.5s)</span>
                  </div>
                  <p className="text-[10px] text-zinc-400 pt-1 border-t border-zinc-800/60">
                    ✨ Audio pads with silence while video holds or continues zooming smoothly.
                  </p>
                </div>
              </div>
            </div>

            {/* Kinetic Captions Section */}
            <div className="pt-5 border-t border-zinc-800/80 space-y-4">
              <div>
                <span className="text-sm font-bold text-white flex items-center gap-2">
                  <span>💬</span> Kinetic Captions
                </span>
                <p className="text-[11px] text-zinc-400">
                  Burns word-by-word highlighted captions into the final render. Applied at assembly, so change it any time before you render.
                </p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { id: 'none', label: 'Off', desc: 'No captions' },
                  { id: 'vox', label: 'Vox Minimal', desc: 'White, style-colour highlight' },
                  { id: 'social_pop', label: 'Social Pop', desc: 'Bold capitals, the spoken word pops' },
                  { id: 'clean_news', label: 'Clean News', desc: 'Boxed, broadcast style' },
                ].map((option) => {
                  const isSelected = captionPreset === option.id;
                  return (
                    <div
                      key={option.id}
                      onClick={() => updateBgmConfig({ captionPreset: option.id })}
                      className={`p-2.5 rounded-xl border flex flex-col transition cursor-pointer ${
                        isSelected
                          ? 'bg-indigo-950/40 border-indigo-500/80 text-white shadow-md shadow-indigo-950'
                          : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      <span className="text-xs font-medium leading-tight">{option.label}</span>
                      <span className="text-[10px] text-zinc-400 mt-1">{option.desc}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Film Look Section */}
            <div className="pt-5 border-t border-zinc-800/80 space-y-4">
              <div>
                <span className="text-sm font-bold text-white flex items-center gap-2">
                  <span>🎞️</span> Film Look
                </span>
                <p className="text-[11px] text-zinc-400">
                  A gentle colour grade matched to the video&apos;s style, so archive photos, stock footage and graphics feel like one film. Turning it off makes the final render faster.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 max-w-md">
                {[
                  { id: 'auto' as const, label: 'Matched to style', desc: 'Unified grade (recommended)' },
                  { id: 'off' as const, label: 'Off', desc: 'Original colours, faster render' },
                ].map((option) => (
                  <div
                    key={option.id}
                    onClick={() => updateBgmConfig({ look: option.id })}
                    className={`p-2.5 rounded-xl border flex flex-col transition cursor-pointer ${
                      filmLook === option.id
                        ? 'bg-indigo-950/40 border-indigo-500/80 text-white shadow-md shadow-indigo-950'
                        : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                    }`}
                  >
                    <span className="text-xs font-medium leading-tight">{option.label}</span>
                    <span className="text-[10px] text-zinc-400 mt-1">{option.desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Archive Texture Section */}
            <div className="pt-5 border-t border-zinc-800/80 space-y-4">
              <div>
                <span className="text-sm font-bold text-white flex items-center gap-2">
                  <span>📜</span> Archive Texture
                </span>
                <p className="text-[11px] text-zinc-400">
                  Old photos become prints (border, tilt, shadow, stacked on the previous one); old film gets a gentle projector wobble and grain, with the occasional light leak. Modern stock footage is never touched. Applies to beats rendered after the change.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 max-w-md">
                {[
                  { id: 'auto' as const, label: 'On', desc: 'Archive feels deliberate (recommended)' },
                  { id: 'off' as const, label: 'Off', desc: 'Archive shown as is, faster' },
                ].map((option) => (
                  <div
                    key={option.id}
                    onClick={() => updateBgmConfig({ archiveLook: option.id })}
                    className={`p-2.5 rounded-xl border flex flex-col transition cursor-pointer ${
                      archiveLook === option.id
                        ? 'bg-indigo-950/40 border-indigo-500/80 text-white shadow-md shadow-indigo-950'
                        : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                    }`}
                  >
                    <span className="text-xs font-medium leading-tight">{option.label}</span>
                    <span className="text-[10px] text-zinc-400 mt-1">{option.desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Emphasis Effects Section */}
            <div className="pt-5 border-t border-zinc-800/80 space-y-4">
              <div>
                <span className="text-sm font-bold text-white flex items-center gap-2">
                  <span>💥</span> Emphasis Effects
                </span>
                <p className="text-[11px] text-zinc-400">
                  A camera shake on impact sounds (gunshots, explosions), a freeze-frame with a title on 1-3 big moments, a zoom punch into chapters in fast styles. Captions are never affected. Applied at assembly.
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={emphasisEnabled}
                  onChange={(e) => updateBgmConfig({ emphasisEnabled: e.target.checked })}
                  className="accent-indigo-500"
                />
                <span className="text-zinc-200 font-medium">Emphasis effects on</span>
              </label>
              <div className="space-y-1.5">
                <span className="text-[11px] text-zinc-400">Letterbox bars (thin, 2:1)</span>
                <div className="grid grid-cols-3 gap-2 max-w-md">
                  {[
                    { id: 'auto' as const, label: 'Style default', desc: 'On for cinematic, mystery, true crime, story' },
                    { id: 'on' as const, label: 'On', desc: 'Cinematic bars' },
                    { id: 'off' as const, label: 'Off', desc: 'Full frame' },
                  ].map((option) => (
                    <div
                      key={option.id}
                      onClick={() => updateBgmConfig({ letterbox: option.id })}
                      className={`p-2.5 rounded-xl border flex flex-col transition cursor-pointer ${
                        letterbox === option.id
                          ? 'bg-indigo-950/40 border-indigo-500/80 text-white shadow-md shadow-indigo-950'
                          : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      <span className="text-xs font-medium leading-tight">{option.label}</span>
                      <span className="text-[10px] text-zinc-400 mt-1">{option.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <VoiceCheckPanel
          videoId={id}
          onChecks={setVoiceChecks}
          onRevoiced={() => {
            setCacheBuster(Date.now());
            void fetchVideoData();
          }}
        />

        <NeedsCheckBar videoId={id} refreshKey={cacheBuster} onChanged={() => setCacheBuster(Date.now())} />

        <RhythmPanel videoId={id} refreshKey={cacheBuster} />

        {/* Beat Cards List */}
        <div className="space-y-6">
          {beats.length === 0 ? (
            <div className="p-8 text-center bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-400">
              No approved script beats found for this video.
            </div>
          ) : (
            beats.map((beat, index) => {
              const asset = assetMap.get(index);
              const ttsUnit = ttsUnitMap.get(index);
              const isUploading = uploadingBeat === index;
              const beatErr = beatErrors[index];
              const warnings = beatWarnings[index] || [];
              const currentLicense = licenseTypes[index] || getLastLicenseChoice();

              return (
                <div
                  key={index}
                  className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-md space-y-5"
                >
                  {/* Card Header */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-800 pb-3">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold text-zinc-300 bg-zinc-800 px-2.5 py-1 rounded-md">
                        Beat #{index + 1}
                      </span>
                      {asset ? (
                        <span className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-emerald-950 text-emerald-300 border border-emerald-800 flex items-center gap-1">
                          {asset.visual_type === 'uploaded'
                            ? '✓ Visual Uploaded'
                            : `✓ Auto-generated (${asset.visual_type})`}
                        </span>
                      ) : (
                        <span className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
                          Pending Visual
                        </span>
                      )}
                    </div>

                    {/* Measured TTS Duration */}
                    <div className="text-xs text-zinc-400 flex items-center gap-1.5">
                      <span className="text-zinc-500">TTS Duration:</span>
                      {ttsUnit?.duration_ms ? (
                        <span className="font-semibold text-zinc-200">
                          {(ttsUnit.duration_ms / 1000).toFixed(1)}s
                        </span>
                      ) : (
                        <span className="italic text-zinc-500">Not voiced yet</span>
                      )}
                    </div>
                  </div>

                  {/* Narration Text & Query Hint */}
                  <div className="space-y-2">
                    <p className="text-sm text-zinc-200 font-medium leading-relaxed bg-zinc-950/60 p-3 rounded-xl border border-zinc-800/80">
                      &ldquo;{beat.text}&rdquo;
                    </p>
                    {beat.visual_query && (
                      <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                        <span className="text-zinc-500">Visual Hint:</span>
                        <span className="text-zinc-300 font-mono text-[11px] bg-zinc-800/80 px-2 py-0.5 rounded">
                          {beat.visual_query}
                        </span>
                      </p>
                    )}
                  </div>

                  {/* Beat Narration Audio Player */}
                  {data.job && ttsUnit?.status === 'done' && (
                    <div className="bg-zinc-950/40 p-3 rounded-xl border border-zinc-800/60 space-y-1">
                      <div className="flex items-center justify-between text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                        <span>Beat Audio</span>
                        <VoiceCheckBadge check={voiceChecks.get(index)} />
                      </div>
                      <audio
                        controls
                        className="w-full h-8"
                        src={`/api/jobs/${data.job.id}/units/${index}/audio?v=${cacheBuster}`}
                      />
                    </div>
                  )}

                  {/* Asset Preview Section */}
                  {asset && (
                    <div className="bg-zinc-950/60 p-4 rounded-xl border border-zinc-800 space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-zinc-300 uppercase tracking-wider text-[11px]">
                          Current Visual Asset
                        </span>
                        <span className="text-zinc-400">
                          License: <strong className="text-zinc-200">{asset.license_type}</strong>
                        </span>
                      </div>

                      {/* Video or Image Preview */}
                      <div className="relative aspect-video max-w-md mx-auto bg-black rounded-lg overflow-hidden border border-zinc-800 flex items-center justify-center">
                        <video
                          id={`beat-video-${index}`}
                          controls
                          className="w-full h-full object-contain"
                          src={`/api/videos/${id}/beats/${index}/visual?t=${cacheBuster}`}
                        />
                      </div>

                      {/* Video Trim Controls (not for beats cut from shots: a trim would move every cut off the narration) */}
                      {asset.visual_type !== 'composite' && (
                      <div className="pt-2 border-t border-zinc-800/80 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs">✂️</span>
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                              Start Trim Offset
                            </span>
                          </div>
                          <span className="text-xs font-mono font-bold text-indigo-400 bg-indigo-950/60 px-2 py-0.5 rounded border border-indigo-800/50">
                            {(trimOffsets[index] ?? asset.start_offset_seconds ?? 0).toFixed(1)}s
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          <input
                            type="range"
                            min="0"
                            max="60"
                            step="0.5"
                            value={trimOffsets[index] ?? asset.start_offset_seconds ?? 0}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              setTrimOffsets((prev) => ({ ...prev, [index]: val }));
                              handleSeekBeatVideo(index, val);
                            }}
                            className="w-full accent-indigo-500 cursor-pointer"
                          />

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                            {/* Preset quick jump buttons */}
                            <div className="flex items-center gap-1 text-[10px]">
                              {[0, 1, 2, 5, 10].map((sec) => (
                                <button
                                  key={sec}
                                  type="button"
                                  onClick={() => {
                                    setTrimOffsets((prev) => ({ ...prev, [index]: sec }));
                                    handleSeekBeatVideo(index, sec);
                                  }}
                                  className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 font-mono transition"
                                >
                                  {sec}s
                                </button>
                              ))}
                            </div>

                            <div className="flex items-center gap-2">
                              {savedTrimSuccess[index] && (
                                <span className="text-[11px] text-emerald-400 font-medium flex items-center gap-1">
                                  <span>✓</span> Trim Saved
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() => handleSaveTrim(index)}
                                disabled={savingTrim[index]}
                                className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-xs transition shadow-md shadow-indigo-950"
                              >
                                {savingTrim[index] ? 'Saving...' : 'Save Trim'}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                      )}

                      {asset.source_url && asset.visual_type !== 'composite' && (
                        <p className="text-xs text-zinc-400">
                          Source: <span className="text-zinc-300">{asset.source_url}</span>
                        </p>
                      )}
                      {asset.attribution_text && (
                        <p className="text-xs text-zinc-400">
                          Attribution: <span className="text-zinc-300">{asset.attribution_text}</span>
                        </p>
                      )}
                    </div>
                  )}

                  {/* Shot-by-shot editor for beats composed from the director's shot plan */}
                  {asset?.visual_type === 'composite' && (
                    <ShotEditor videoId={id} beatIndex={index} onChanged={() => setCacheBuster(Date.now())} />
                  )}

                  {/* Alternative Media Candidates & 1-Click Swap Reel */}
                  {(() => {
                    const pool = customCandidates[index] || (Array.isArray(asset?.candidates_json) ? asset.candidates_json : []);
                    const isSwappingThisBeat = swappingBeat === index;
                    const isSearchingThisBeat = searchingBeat === index;

                    return (
                      <div className="bg-zinc-950/70 p-4 rounded-xl border border-zinc-800 space-y-3">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-sm">🔄</span>
                            <span className="font-semibold text-zinc-200 text-xs uppercase tracking-wider">
                              Alternative Media Candidates ({pool.length})
                            </span>
                          </div>

                          {/* Quick Ad-Hoc Archive Search */}
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
                                  handleSearchCandidates(index);
                                }
                              }}
                              className="px-2.5 py-1 text-xs rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 w-44 sm:w-56"
                            />
                            <button
                              type="button"
                              onClick={() => handleSearchCandidates(index)}
                              disabled={isSearchingThisBeat}
                              className="px-2.5 py-1 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition cursor-pointer"
                            >
                              {isSearchingThisBeat ? '...' : 'Search'}
                            </button>
                          </div>
                        </div>

                        {pool.length > 0 ? (
                          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-3 pt-1">
                            {pool.map((cand: MediaCandidate, cIdx: number) => {
                              const isCurrent =
                                asset?.source_url?.includes(cand.downloadUrl) ||
                                (asset?.attribution_text && cand.attribution && asset.attribution_text === cand.attribution);

                              return (
                                <div
                                  key={cand.id || cIdx}
                                  className={`group relative rounded-xl overflow-hidden border transition bg-zinc-900 flex flex-col justify-between ${
                                    isCurrent
                                      ? 'border-emerald-500 ring-2 ring-emerald-500/30'
                                      : 'border-zinc-800 hover:border-indigo-500/80'
                                  }`}
                                >
                                  {/* Media Thumbnail */}
                                  <div className="relative aspect-video w-full bg-zinc-950 overflow-hidden">
                                    {cand.thumbnailUrl ? (
                                      <img
                                        src={cand.thumbnailUrl}
                                        alt={cand.title || 'Candidate'}
                                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                      />
                                    ) : (
                                      <div className="w-full h-full flex items-center justify-center text-zinc-600 text-xs">
                                        No preview
                                      </div>
                                    )}

                                    {/* Provider badge */}
                                    <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-black/80 text-zinc-300 backdrop-blur-sm">
                                      {cand.provider}
                                    </span>

                                    {/* Type badge */}
                                    <span className="absolute top-1 right-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold bg-black/80 text-zinc-400">
                                      {cand.mediaType === 'video' ? '🎬' : '📷'}
                                    </span>
                                  </div>

                                  {/* Title & 1-Click Swap Button */}
                                  <div className="p-2 space-y-1.5 flex flex-col justify-between flex-1">
                                    <p
                                      className="text-[11px] text-zinc-300 font-medium line-clamp-1"
                                      title={cand.title}
                                    >
                                      {cand.title || 'Candidate media'}
                                    </p>

                                    <button
                                      type="button"
                                      disabled={isSwappingThisBeat || !!isCurrent}
                                      onClick={() => handleSwapCandidate(index, cand)}
                                      className={`w-full py-1 rounded-lg text-xs font-medium transition cursor-pointer flex items-center justify-center gap-1 ${
                                        isCurrent
                                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-800 cursor-default'
                                          : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm shadow-indigo-950'
                                      }`}
                                    >
                                      {isCurrent ? (
                                        <span>✓ Active</span>
                                      ) : isSwappingThisBeat ? (
                                        <span>Swapping...</span>
                                      ) : (
                                        <span>⚡ Select</span>
                                      )}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-xs text-zinc-500 italic">
                            No pre-scraped candidates in pool. Use the search bar above to fetch authentic media from Wikimedia, NASA, or stock.
                          </p>
                        )}
                      </div>
                    );
                  })()}

                  {/* Upload & Provenance Form */}
                  <div className="bg-zinc-950/40 p-4 rounded-xl border border-zinc-800/80 space-y-4">
                    <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                      {asset ? 'Replace Visual Asset' : 'Upload Visual Asset'}
                    </h4>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* File Input */}
                      <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1">
                          Media File (MP4, MOV, WebM, PNG, JPG, WebP)
                        </label>
                        <input
                          type="file"
                          accept="video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp"
                          onChange={(e) => {
                            const file = e.target.files?.[0] || null;
                            setUploadFiles((prev) => ({ ...prev, [index]: file }));
                          }}
                          className="w-full text-xs text-zinc-300 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-zinc-800 file:text-zinc-200 hover:file:bg-zinc-700 cursor-pointer"
                        />
                      </div>

                      {/* License Type Dropdown */}
                      <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1">
                          License Type
                        </label>
                        <select
                          value={currentLicense}
                          onChange={(e) => {
                            const val = e.target.value;
                            setLicenseTypes((prev) => ({ ...prev, [index]: val }));
                            setLastLicenseChoice(val);
                          }}
                          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                        >
                          {LICENSE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Source Note Input */}
                      <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1">
                          Source Note / URL (optional)
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. personal camera footage, envato link"
                          value={sourceNotes[index] || ''}
                          onChange={(e) =>
                            setSourceNotes((prev) => ({ ...prev, [index]: e.target.value }))
                          }
                          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                        />
                      </div>

                      {/* Attribution Text Input (required if CC-BY or CC BY-SA) */}
                      <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1">
                          Attribution Text {(currentLicense === 'cc_by' || currentLicense === 'cc_by_sa') && <span className="text-red-400">*</span>}
                        </label>
                        <input
                          type="text"
                          placeholder={
                            currentLicense === 'cc_by' || currentLicense === 'cc_by_sa'
                              ? 'Required: Creator name / credit'
                              : 'Optional attribution'
                          }
                          value={attributionTexts[index] || ''}
                          onChange={(e) =>
                            setAttributionTexts((prev) => ({ ...prev, [index]: e.target.value }))
                          }
                          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>

                    {/* Upload Errors / Warnings Display */}
                    {beatErr && (
                      <p className="text-xs text-red-400 font-medium">⚠️ {beatErr}</p>
                    )}

                    {warnings.length > 0 && (
                      <div className="space-y-1 p-2.5 rounded-lg bg-amber-950/40 border border-amber-800 text-xs text-amber-200">
                        {warnings.map((w, wIdx) => (
                          <p key={wIdx}>⚠️ {w}</p>
                        ))}
                      </div>
                    )}

                    {/* Submit Upload Button */}
                    <div className="flex justify-end pt-1">
                      <button
                        onClick={() => handleUpload(index)}
                        disabled={isUploading || !uploadFiles[index]}
                        className={`px-4 py-2 rounded-lg text-xs font-medium transition ${
                          uploadFiles[index] && !isUploading
                            ? 'bg-zinc-100 hover:bg-white text-zinc-900 cursor-pointer shadow-sm'
                            : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                        }`}
                      >
                        {isUploading ? 'Uploading & Validating...' : asset ? 'Replace Visual' : 'Upload Visual'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
