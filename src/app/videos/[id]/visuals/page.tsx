'use client';

import React, { useEffect, useState, useRef, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import BatchVisualUploader from './batch-uploader';
import { VoiceCheckPanel, type BeatVoiceCheck } from './voice-check-panel';
import { VoicePlanPanel } from './voice-plan-panel';
import { RenderSettingsCard } from './render-settings-card';
import { AssemblyExtrasCard } from './assembly-extras-card';
import { BeatCard } from './beat-card';
import { RhythmPanel } from './rhythm-panel';
import { NeedsCheckBar } from './needs-check-bar';
import type { MediaCandidate } from '@/pipeline/visuals/types';
import { DrawingsPanel } from '../drawings-panel';
import type { ScriptBeat as PlannedBeat } from '@/lib/script/generate-script';
import { packForVideo } from '@/lib/styles/compose';

interface VisualsPageProps {
  params: Promise<{ id: string }>;
}

import { LICENSE_OPTIONS, type JobUnit, type ProgressData, type ScriptBeat, type VideoAsset } from './visuals-types';

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
  const [beatSync, setBeatSync] = useState(true);
  const [previewingSfx, setPreviewingSfx] = useState<string | null>(null);

  // Beat Pacing & Breathing Room state (default 0.5s pause)
  const [beatPauseSeconds, setBeatPauseSeconds] = useState(0.5);

  // Kinetic captions burned into the final render ('none' = off)
  const [captionPreset, setCaptionPreset] = useState<string>('none');
  // The style's colour grade at mastering ('auto') or none ('off', faster to render)
  const [filmLook, setFilmLook] = useState<'auto' | 'off'>('auto');
  const [archiveLook, setArchiveLook] = useState<'auto' | 'off'>('auto');
  const [emphasisEnabled, setEmphasisEnabled] = useState(true);
  const [parallax, setParallax] = useState(true);
  const [sourceTags, setSourceTags] = useState(true);
  const [upscale, setUpscale] = useState(false);
  const [youtubeCc, setYoutubeCc] = useState(false);
  const [youtubeKey, setYoutubeKey] = useState(false);
  const [illustrations, setIllustrations] = useState(false);
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
    beatSync?: boolean;
    beatPauseSeconds?: number;
    captionPreset?: string;
    look?: 'auto' | 'off';
    archiveLook?: 'auto' | 'off';
    transitionIntensity?: 'subtle' | 'balanced' | 'bold';
    transitionRendered?: boolean;
    emphasisEnabled?: boolean;
    parallax?: boolean;
    sourceTags?: boolean;
    upscale?: boolean;
    youtubeCc?: boolean;
    illustrations?: boolean;
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
    const nextBeatSync = updates.beatSync !== undefined ? updates.beatSync : beatSync;
    const nextBeatPause =
      updates.beatPauseSeconds !== undefined ? updates.beatPauseSeconds : beatPauseSeconds;
    const nextCaptionPreset =
      updates.captionPreset !== undefined ? updates.captionPreset : captionPreset;
    const nextLook = updates.look !== undefined ? updates.look : filmLook;
    const nextArchiveLook = updates.archiveLook !== undefined ? updates.archiveLook : archiveLook;
    const nextEmphasis = updates.emphasisEnabled !== undefined ? updates.emphasisEnabled : emphasisEnabled;
    const nextParallax = updates.parallax !== undefined ? updates.parallax : parallax;
    const nextSourceTags = updates.sourceTags !== undefined ? updates.sourceTags : sourceTags;
    const nextUpscale = updates.upscale !== undefined ? updates.upscale : upscale;
    const nextYoutubeCc = updates.youtubeCc !== undefined ? updates.youtubeCc : youtubeCc;
    const nextIllustrations = updates.illustrations !== undefined ? updates.illustrations : illustrations;
    setParallax(nextParallax);
    setSourceTags(nextSourceTags);
    setUpscale(nextUpscale);
    setYoutubeCc(nextYoutubeCc);
    setIllustrations(nextIllustrations);
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
    setBeatSync(nextBeatSync);
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
          beatSync: nextBeatSync,
          beatPauseSeconds: nextBeatPause,
          captionPreset: nextCaptionPreset,
          look: nextLook,
          archiveLook: nextArchiveLook,
          emphasisEnabled: nextEmphasis,
          parallax: nextParallax,
          sourceTags: nextSourceTags,
          upscale: nextUpscale,
          youtubeCc: nextYoutubeCc,
          illustrations: nextIllustrations,
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
            setBeatSync(bData.bgm.beatSync !== false);
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
          if (bData.parallax !== undefined) setParallax(bData.parallax !== false);
          if (bData.sourceTags !== undefined) setSourceTags(bData.sourceTags !== false);
          if (bData.upscale !== undefined) setUpscale(bData.upscale === true);
          if (bData.youtubeCc !== undefined) setYoutubeCc(bData.youtubeCc === true);
          if (bData.youtubeKey !== undefined) setYoutubeKey(bData.youtubeKey === true);
          if (bData.illustrations !== undefined) setIllustrations(bData.illustrations === true);
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
  const drawn = Boolean(packForVideo(data?.video)?.drawn);
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
    if (drawn) {
      // Missing drawings would show as doodle text in the finished video: say so first
      const status = await fetch(`/api/videos/${id}/drawings`)
        .then((r) => (r.ok ? (r.json() as Promise<{ codes: string[]; filed: string[] }>) : null))
        .catch(() => null);
      const missing = status ? status.codes.filter((c) => !status.filed.includes(c)) : [];
      if (
        missing.length > 0 &&
        !window.confirm(
          `${missing.length} drawing${missing.length === 1 ? ' is' : 's are'} still missing (${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}). Those shots will show their narration as doodle text. Assemble anyway?`,
        )
      ) {
        return;
      }
    }
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
              href={`/videos/${id}/storyboard`}
              className="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800 transition flex items-center gap-1 text-xs font-semibold"
            >
              <span>🎞️</span>
              <span>Storyboard</span>
            </Link>
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
                {drawn
                  ? 'A stickman video shows only your drawings and its doodle cards. Drop your drawings on the drawing brief below; a shot without its drawing shows its line as doodle text until it arrives.'
                  : 'Beats you don’t upload for are auto-generated (chart, map, newspaper, archive, stock) from their visual type during voicing. Upload only to override one. Accepted formats: MP4, MOV, WebM, PNG, JPG, WebP.'}
              </p>
            </div>

            {/* Assemble Gate & Batch Actions */}
            <div className="flex flex-col sm:flex-row items-end sm:items-center gap-3">
              {/* Stickman videos take drawings in the drawing brief below instead */}
              {!drawn && (
              <button
                type="button"
                onClick={() => setShowBatchUploader((prev) => !prev)}
                className="px-4 py-2.5 rounded-xl font-bold text-xs transition shadow-lg bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-850 text-indigo-300 border border-indigo-500/30 hover:border-indigo-500/60 flex items-center gap-2 cursor-pointer"
              >
                <span>🚀</span>
                <span>{showBatchUploader ? 'Hide Batch Uploader' : 'Batch Upload Visuals'}</span>
              </button>
              )}

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

        {drawn && (
          <DrawingsPanel
            videoId={id}
            beats={beats as unknown as PlannedBeat[]}
            bibleTranslation={packForVideo(data.video)?.signatureShots?.includes('verse') ? (data.video.script_json?.bible_translation ?? 'webbe') : undefined}
            onDrawingsChanged={() => {
              setCacheBuster(Date.now());
              fetchVideoData();
            }}
          />
        )}

        {/* Batch Visuals Uploader Drawer / Card */}
        {!drawn && showBatchUploader && (
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

        <RenderSettingsCard
          drawn={drawn}
          youtubeKey={youtubeKey}
          bgmEnabled={bgmEnabled}
          bgmTrack={bgmTrack}
          bgmVolume={bgmVolume}
          previewingTrack={previewingTrack}
          savingBgm={savingBgm}
          padStyle={padStyle}
          stillMotion={stillMotion}
          transition={transition}
          transitionIntensity={transitionIntensity}
          transitionRendered={transitionRendered}
          sfxEnabled={sfxEnabled}
          sfxTrack={sfxTrack}
          sfxVolume={sfxVolume}
          narrationSounds={narrationSounds}
          soundMoments={soundMoments}
          soundBeds={soundBeds}
          paletteSounds={paletteSounds}
          musicAccents={musicAccents}
          beatSync={beatSync}
          previewingSfx={previewingSfx}
          beatPauseSeconds={beatPauseSeconds}
          captionPreset={captionPreset}
          filmLook={filmLook}
          archiveLook={archiveLook}
          emphasisEnabled={emphasisEnabled}
          parallax={parallax}
          sourceTags={sourceTags}
          upscale={upscale}
          youtubeCc={youtubeCc}
          illustrations={illustrations}
          letterbox={letterbox}
          updateBgmConfig={updateBgmConfig}
          togglePreviewSfx={togglePreviewSfx}
          togglePreviewTrack={togglePreviewTrack}
        />

        <AssemblyExtrasCard videoId={id} />

        <VoicePlanPanel
          videoId={id}
          onRevoiced={() => {
            setCacheBuster(Date.now());
            void fetchVideoData();
          }}
        />

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
                <BeatCard
                  key={index}
                  beat={beat}
                  index={index}
                  asset={asset}
                  ttsUnit={ttsUnit}
                  isUploading={isUploading}
                  beatErr={beatErr}
                  warnings={warnings}
                  currentLicense={currentLicense}
                  id={id}
                  drawn={drawn}
                  data={data}
                  uploadFiles={uploadFiles}
                  setUploadFiles={setUploadFiles}
                  setLicenseTypes={setLicenseTypes}
                  sourceNotes={sourceNotes}
                  setSourceNotes={setSourceNotes}
                  attributionTexts={attributionTexts}
                  setAttributionTexts={setAttributionTexts}
                  cacheBuster={cacheBuster}
                  setCacheBuster={setCacheBuster}
                  voiceChecks={voiceChecks}
                  trimOffsets={trimOffsets}
                  setTrimOffsets={setTrimOffsets}
                  savingTrim={savingTrim}
                  savedTrimSuccess={savedTrimSuccess}
                  swappingBeat={swappingBeat}
                  searchQueries={searchQueries}
                  setSearchQueries={setSearchQueries}
                  searchingBeat={searchingBeat}
                  customCandidates={customCandidates}
                  setLastLicenseChoice={setLastLicenseChoice}
                  handleSwapCandidate={handleSwapCandidate}
                  handleSearchCandidates={handleSearchCandidates}
                  handleSeekBeatVideo={handleSeekBeatVideo}
                  handleSaveTrim={handleSaveTrim}
                  handleUpload={handleUpload}
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
