'use client';

import React from 'react';

/** What a settings change can carry (saved by the visuals page's updateBgmConfig). */
export interface RenderSettingsUpdate {
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
}

export interface RenderSettingsCardProps {
  drawn: boolean;
  youtubeKey: boolean;
  bgmEnabled: boolean;
  bgmTrack: string;
  bgmVolume: number;
  previewingTrack: string | null;
  savingBgm: boolean;
  padStyle: 'blur' | 'black';
  stillMotion: 'zoom' | 'static';
  transition: string;
  transitionIntensity: 'subtle' | 'balanced' | 'bold';
  transitionRendered: boolean;
  sfxEnabled: boolean;
  sfxTrack: string;
  sfxVolume: number;
  narrationSounds: boolean;
  soundMoments: Array<{ beat_index: number; trigger: string; sound: string }> | null;
  soundBeds: Array<{ start_beat: number; end_beat: number; sound: string }> | null;
  paletteSounds: boolean;
  musicAccents: boolean;
  beatSync: boolean;
  previewingSfx: string | null;
  beatPauseSeconds: number;
  captionPreset: string;
  filmLook: 'auto' | 'off';
  archiveLook: 'auto' | 'off';
  emphasisEnabled: boolean;
  parallax: boolean;
  sourceTags: boolean;
  upscale: boolean;
  youtubeCc: boolean;
  illustrations: boolean;
  letterbox: 'auto' | 'on' | 'off';
  updateBgmConfig: (updates: RenderSettingsUpdate) => Promise<void> | void;
  togglePreviewSfx: (trackId: string) => void;
  togglePreviewTrack: (trackId: string) => void;
}

/**
 * The video's render settings: background music and ducking, framing, still motion,
 * transitions and their sounds, pacing, captions, film look and the footage options. Every
 * change goes through updateBgmConfig, which saves it.
 */
export function RenderSettingsCard({ drawn, youtubeKey, bgmEnabled, bgmTrack, bgmVolume, previewingTrack, savingBgm, padStyle, stillMotion, transition, transitionIntensity, transitionRendered, sfxEnabled, sfxTrack, sfxVolume, narrationSounds, soundMoments, soundBeds, paletteSounds, musicAccents, beatSync, previewingSfx, beatPauseSeconds, captionPreset, filmLook, archiveLook, emphasisEnabled, parallax, sourceTags, upscale, youtubeCc, illustrations, letterbox, updateBgmConfig, togglePreviewSfx, togglePreviewTrack }: RenderSettingsCardProps) {
  return (
    <>
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
                <label className="flex items-start gap-2 pt-1 text-[11px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={beatSync}
                    onChange={(e) => updateBgmConfig({ beatSync: e.target.checked })}
                    className="accent-indigo-500 mt-0.5"
                  />
                  <span>
                    <span className="text-zinc-200 font-semibold">Cuts on the beat</span>
                    <span className="text-zinc-500"> · the music starts where its beats meet the most cuts (the cuts stay on the words)</span>
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
                  { id: 'doodle', label: 'Doodle', desc: 'Handwritten ink, the spoken word pops (stickman)' },
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

            {/* Footage-only settings: a stickman video shows only the creator's drawings */}
            {!drawn && (<>
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

            {/* 2.5D Parallax Section */}
            <div className="pt-5 border-t border-zinc-800/80 space-y-2">
              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={parallax}
                  onChange={(e) => updateBgmConfig({ parallax: e.target.checked })}
                  className="accent-indigo-500 mt-0.5"
                />
                <span>
                  <span className="text-sm font-bold text-white">🏔️ 2.5D parallax on photos</span>
                  <span className="block text-[11px] text-zinc-400 mt-0.5">
                    Landscape photos move in depth (near things slide against the background as the camera pushes in) instead of a flat pan. A small depth model runs on this computer (downloaded once, about 30 MB); slow on a small laptop, around half a minute per photo shot. Archive prints and collages keep their own look. Applies to beats rendered after the change.
                  </span>
                </span>
              </label>
            </div>

            {/* AI illustrations Section */}
            <div className="pt-5 border-t border-zinc-800/80 space-y-2">
              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={illustrations}
                  onChange={(e) => updateBgmConfig({ illustrations: e.target.checked })}
                  className="accent-indigo-500 mt-0.5"
                />
                <span>
                  <span className="text-sm font-bold text-white">🎨 AI illustrations where no camera could go</span>
                  <span className="block text-[11px] text-zinc-400 mt-0.5">
                    The shot planner may use a free AI illustration (Pollinations, no credits) only for what was never filmed or photographed: space, the ancient past, inside the body, legends. At most 1 in 8 shots and 6 per video, each labelled &quot;Illustration&quot; on screen; real footage everywhere else. Applies when shots are planned (new videos, or re-planning on the review page). The ✨ Illustration button on any shot works either way.
                  </span>
                </span>
              </label>
            </div>

            {/* Creative Commons YouTube Section */}
            <div className="pt-5 border-t border-zinc-800/80 space-y-2">
              <label className={`flex items-start gap-2 text-xs ${youtubeKey ? 'cursor-pointer' : 'opacity-50'}`}>
                <input
                  type="checkbox"
                  checked={youtubeCc}
                  disabled={!youtubeKey}
                  onChange={(e) => updateBgmConfig({ youtubeCc: e.target.checked })}
                  className="accent-indigo-500 mt-0.5"
                />
                <span>
                  <span className="text-sm font-bold text-white">▶️ Creative Commons YouTube footage</span>
                  <span className="block text-[11px] text-zinc-400 mt-0.5">
                    {youtubeKey
                      ? 'When the stock libraries and archives have few moving clips for a shot, CC-licensed YouTube videos are searched too (re-uploads of broadcasts and highlights are turned away), the matching seconds are found, and the channel is credited with a link in the description. About 80 searches a day.'
                      : 'Add YOUTUBE_API_KEY to .env.local to use Creative Commons YouTube footage.'}
                  </span>
                </span>
              </label>
            </div>

            {/* Upscaling Section */}
            <div className="pt-5 border-t border-zinc-800/80 space-y-2">
              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={upscale}
                  onChange={(e) => updateBgmConfig({ upscale: e.target.checked })}
                  className="accent-indigo-500 mt-0.5"
                />
                <span>
                  <span className="text-sm font-bold text-white">🔍 Sharpen small photos</span>
                  <span className="block text-[11px] text-zinc-400 mt-0.5">
                    Photos narrower than 960 px are upscaled 2x by an AI model on this computer before use, so old pictures look crisp full screen. Very slow on a small laptop: about 3 minutes per small photo (each is done once and kept). Applies to shots rendered after the change.
                  </span>
                </span>
              </label>
            </div>

            </>)}

            {/* Source tags Section */}
            <div className="pt-5 border-t border-zinc-800/80 space-y-2">
              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={sourceTags}
                  onChange={(e) => updateBgmConfig({ sourceTags: e.target.checked })}
                  className="accent-indigo-500 mt-0.5"
                />
                <span>
                  <span className="text-sm font-bold text-white">🔎 Source tags on stats and charts</span>
                  <span className="block text-[11px] text-zinc-400 mt-0.5">
                    A small &quot;Source: UEFA&quot; in the corner of every stat, chart and comparison, from the research facts it cites. Applies to shots rendered after the change.
                  </span>
                </span>
              </label>
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
    </>
  );
}
