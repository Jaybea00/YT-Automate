'use client';

import React from 'react';
import type { MediaCandidate } from '@/pipeline/visuals/types';
import { VoiceCheckBadge, type BeatVoiceCheck } from './voice-check-panel';
import { ShotEditor } from './shot-editor';
import { LICENSE_OPTIONS, type JobUnit, type ProgressData, type ScriptBeat, type VideoAsset } from './visuals-types';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export interface BeatCardProps {
  beat: ScriptBeat;
  index: number;
  asset: VideoAsset | undefined;
  ttsUnit: JobUnit | undefined;
  isUploading: boolean;
  beatErr: string | null | undefined;
  warnings: string[];
  currentLicense: string;
  id: string;
  drawn: boolean;
  data: ProgressData;
  uploadFiles: Record<number, File | null>;
  setUploadFiles: Setter<Record<number, File | null>>;
  setLicenseTypes: Setter<Record<number, string>>;
  sourceNotes: Record<number, string>;
  setSourceNotes: Setter<Record<number, string>>;
  attributionTexts: Record<number, string>;
  setAttributionTexts: Setter<Record<number, string>>;
  cacheBuster: number;
  setCacheBuster: Setter<number>;
  voiceChecks: Map<number, BeatVoiceCheck>;
  trimOffsets: Record<number, number>;
  setTrimOffsets: Setter<Record<number, number>>;
  savingTrim: Record<number, boolean>;
  savedTrimSuccess: Record<number, boolean>;
  swappingBeat: number | null;
  searchQueries: Record<number, string>;
  setSearchQueries: Setter<Record<number, string>>;
  searchingBeat: number | null;
  customCandidates: Record<number, MediaCandidate[]>;
  setLastLicenseChoice: (val: string) => void;
  handleSwapCandidate: (beatIndex: number, candidate: MediaCandidate) => unknown;
  handleSearchCandidates: (beatIndex: number) => unknown;
  handleSeekBeatVideo: (beatIndex: number, seconds: number) => unknown;
  handleSaveTrim: (beatIndex: number) => unknown;
  handleUpload: (beatIndex: number) => unknown;
}

/**
 * One beat on the visuals page: its narration and voice, its visual (with trim controls, the
 * shot editor for beats cut from a shot plan, other candidates to swap in, a quick search) and
 * the upload form with licensing. The page keeps the state; the card shows and changes it.
 */
export function BeatCard({ beat, index, asset, ttsUnit, isUploading, beatErr, warnings, currentLicense, id, drawn, data, uploadFiles, setUploadFiles, setLicenseTypes, sourceNotes, setSourceNotes, attributionTexts, setAttributionTexts, cacheBuster, setCacheBuster, voiceChecks, trimOffsets, setTrimOffsets, savingTrim, savedTrimSuccess, swappingBeat, searchQueries, setSearchQueries, searchingBeat, customCandidates, setLastLicenseChoice, handleSwapCandidate, handleSearchCandidates, handleSeekBeatVideo, handleSaveTrim, handleUpload }: BeatCardProps) {
  return (
                <div
                  
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
                    <ShotEditor videoId={id} beatIndex={index} drawn={drawn} onChanged={() => setCacheBuster(Date.now())} />
                  )}

                  {/* Alternative Media Candidates & 1-Click Swap Reel */}
                  {!drawn && (() => {
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
                  {/* A stickman beat takes drawings shot by shot (a whole-beat upload would replace them all) */}
                  {!drawn && (
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
                  )}
                </div>
  );
}
