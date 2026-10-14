'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  BatchFileItem,
  autoMapFilesToBeats,
  AutoMapOptions,
} from '@/lib/visuals/batch-mapper';

export interface BatchUploaderProps {
  videoId: string;
  totalBeats: number;
  beats: Array<{
    text?: string;
    narration?: string;
    visual_type?: string;
    visual_query?: string;
  }>;
  existingAssetBeatIndices: Set<number>;
  onBeatUploaded?: (beatIndex: number) => void;
  onBatchComplete?: () => void;
  onClose?: () => void;
}

const LICENSE_OPTIONS = [
  { value: 'own_work', label: 'Original Work (Own Creation)' },
  { value: 'royalty_free', label: 'Stock (Pexels / Pixabay License)' },
  { value: 'cc0', label: 'Public Domain / CC0' },
  { value: 'cc_by', label: 'Creative Commons Attribution (CC-BY)' },
  { value: 'cc_by_sa', label: 'Creative Commons Attribution-ShareAlike (CC BY-SA)' },
];

export default function BatchVisualUploader({
  videoId,
  totalBeats,
  beats,
  existingAssetBeatIndices,
  onBeatUploaded,
  onBatchComplete,
  onClose,
}: BatchUploaderProps) {
  const [items, setItems] = useState<BatchFileItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [mappingMode, setMappingMode] = useState<'smart' | 'sequential'>('smart');
  const [startBeatIndex, setStartBeatIndex] = useState(0);
  const [skipExisting, setSkipExisting] = useState(false);
  const [defaultLicense, setDefaultLicense] = useState('own_work');
  const [defaultSourceNote, setDefaultSourceNote] = useState('');
  const [defaultAttribution, setDefaultAttribution] = useState('');

  // Upload runner state
  const [isUploading, setIsUploading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [overallProgress, setOverallProgress] = useState(0); // 0..100
  const [uploadedCount, setUploadedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isPausedRef = useRef(false);
  const previewUrlsRef = useRef<Set<string>>(new Set());

  // Clean up object URLs and abort pending controllers strictly on unmount
  useEffect(() => {
    return () => {
      previewUrlsRef.current.forEach((url) => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Ignore
        }
      });
      previewUrlsRef.current.clear();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []); // Empty deps: must only run when unmounting

  // Handle files added (drag or file picker)
  const processFiles = useCallback(
    (newFiles: FileList | File[]) => {
      const fileArray = Array.from(newFiles).filter((f) => {
        const type = f.type.toLowerCase();
        const ext = f.name.toLowerCase();
        return (
          type.startsWith('video/') ||
          type.startsWith('image/') ||
          /\.(mp4|mov|webm|png|jpg|jpeg|webp)$/i.test(ext)
        );
      });

      if (fileArray.length === 0) return;

      const opts: AutoMapOptions = {
        mode: mappingMode,
        startBeat: startBeatIndex,
        defaultLicense,
        existingAssetBeatIndices,
        skipExisting,
      };

      const mapped = autoMapFilesToBeats(fileArray, totalBeats, opts);

      // Create preview URLs
      mapped.forEach((item) => {
        try {
          const url = URL.createObjectURL(item.file);
          item.previewUrl = url;
          previewUrlsRef.current.add(url);
        } catch {
          // Ignore
        }
        item.sourceNote = defaultSourceNote;
        item.attributionText = defaultAttribution;
      });

      setItems(mapped);
      setUploadedCount(0);
      setFailedCount(0);
      setOverallProgress(0);
    },
    [
      mappingMode,
      startBeatIndex,
      defaultLicense,
      defaultSourceNote,
      defaultAttribution,
      existingAssetBeatIndices,
      skipExisting,
      totalBeats,
    ],
  );

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer?.files) {
      processFiles(e.dataTransfer.files);
    }
  }

  function handleReMap(newMode: 'smart' | 'sequential') {
    setMappingMode(newMode);
    if (items.length === 0) return;

    const rawFiles = items.map((i) => i.file);
    const opts: AutoMapOptions = {
      mode: newMode,
      startBeat: startBeatIndex,
      defaultLicense,
      existingAssetBeatIndices,
      skipExisting,
    };
    const mapped = autoMapFilesToBeats(rawFiles, totalBeats, opts);

    // Keep existing previews and settings
    mapped.forEach((m, idx) => {
      const old = items[idx];
      if (old) {
        m.previewUrl = old.previewUrl;
        m.sourceNote = old.sourceNote;
        m.attributionText = old.attributionText;
        m.licenseType = old.licenseType;
      }
    });

    setItems(mapped);
  }

  function handleApplyDefaults() {
    setItems((prev) =>
      prev.map((item) => {
        if (item.status === 'done') return item;
        return {
          ...item,
          licenseType: defaultLicense,
          sourceNote: defaultSourceNote || item.sourceNote,
          attributionText: defaultAttribution || item.attributionText,
        };
      }),
    );
  }

  function handleItemBeatChange(id: string, newBeatIndex: number | null) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, assignedBeatIndex: newBeatIndex } : item)),
    );
  }

  function handleRemoveItem(id: string) {
    setItems((prev) => {
      const toRemove = prev.find((i) => i.id === id);
      if (toRemove?.previewUrl) {
        try {
          URL.revokeObjectURL(toRemove.previewUrl);
        } catch {}
        previewUrlsRef.current.delete(toRemove.previewUrl);
      }
      return prev.filter((i) => i.id !== id);
    });
  }

  function handleClearAll() {
    previewUrlsRef.current.forEach((url) => {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    });
    previewUrlsRef.current.clear();
    setItems([]);
    setUploadedCount(0);
    setFailedCount(0);
    setOverallProgress(0);
    setIsUploading(false);
  }

  // Upload single file item
  async function uploadItem(
    item: BatchFileItem,
    signal: AbortSignal,
  ): Promise<{ success: boolean; warnings?: string[]; error?: string }> {
    if (item.assignedBeatIndex === null) {
      return { success: false, error: 'No beat assigned' };
    }

    const formData = new FormData();
    formData.append('file', item.file);
    formData.append('license_type', item.licenseType);
    if (item.sourceNote.trim()) formData.append('source_note', item.sourceNote.trim());
    if (item.attributionText.trim()) formData.append('attribution_text', item.attributionText.trim());

    const res = await fetch(`/api/videos/${videoId}/beats/${item.assignedBeatIndex}/visual`, {
      method: 'POST',
      body: formData,
      signal,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error || `Upload failed (HTTP ${res.status})`);
    }

    return {
      success: true,
      warnings: json.warnings,
    };
  }

  // Start Batch Upload execution with concurrency = 2
  async function handleStartBatchUpload() {
    if (items.length === 0 || isUploading) return;

    setIsUploading(true);
    setIsPaused(false);
    isPausedRef.current = false;
    abortControllerRef.current = new AbortController();

    const signal = abortControllerRef.current.signal;
    const CONCURRENCY = 2;

    const pendingIndices = items
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => item.status !== 'done' && item.assignedBeatIndex !== null);

    let completedInRun = items.filter((i) => i.status === 'done').length;
    let failedInRun = 0;
    const totalToUpload = items.length;

    // Queue of pending tasks for workers to safely shift from
    const queue = [...pendingIndices];

    async function worker() {
      while (queue.length > 0 && !signal.aborted) {
        if (isPausedRef.current) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }

        const currentTask = queue.shift();
        if (!currentTask) break;

        const { item, idx } = currentTask;

        // Update item status to uploading
        setItems((prev) =>
          prev.map((it, i) =>
            i === idx ? { ...it, status: 'uploading', uploadProgress: 50, error: undefined } : it,
          ),
        );

        try {
          const result = await uploadItem(item, signal);

          setItems((prev) =>
            prev.map((it, i) =>
              i === idx
                ? {
                    ...it,
                    status: 'done',
                    uploadProgress: 100,
                    warnings: result.warnings,
                    error: undefined,
                  }
                : it,
            ),
          );

          completedInRun++;
          setUploadedCount(completedInRun);
          if (onBeatUploaded && item.assignedBeatIndex !== null) {
            try {
              onBeatUploaded(item.assignedBeatIndex);
            } catch {
              // Ignore callback error
            }
          }
        } catch (err) {
          if (signal.aborted) return;
          const errMsg = err instanceof Error ? err.message : 'Upload failed';

          setItems((prev) =>
            prev.map((it, i) =>
              i === idx ? { ...it, status: 'error', uploadProgress: 0, error: errMsg } : it,
            ),
          );

          failedInRun++;
          setFailedCount(failedInRun);
        }

        // Update overall progress
        const overallPct = Math.round((completedInRun / totalToUpload) * 100);
        setOverallProgress(overallPct);
      }
    }

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, Math.max(1, queue.length)) },
      () => worker(),
    );
    await Promise.all(workers);

    setIsUploading(false);
    if (!signal.aborted && onBatchComplete) {
      onBatchComplete();
    }
  }

  function handleCancelUpload() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsUploading(false);
    setIsPaused(false);
  }

  function handleTogglePause() {
    isPausedRef.current = !isPausedRef.current;
    setIsPaused(isPausedRef.current);
  }

  // Summary counts
  const validAssignedCount = items.filter((i) => i.assignedBeatIndex !== null).length;
  const unassignedCount = items.length - validAssignedCount;
  const duplicateBeatsCount = new Set(
    items.map((i) => i.assignedBeatIndex).filter((idx): idx is number => idx !== null),
  ).size;
  const hasCollisions = validAssignedCount > duplicateBeatsCount;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-zinc-800">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              Bulk Production
            </span>
            <span className="text-xs text-zinc-400">
              Total video beats: <strong className="text-white">{totalBeats}</strong>
            </span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
            <span>🚀</span> Batch Visuals Uploader
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            Drop all your visual clips or images at once. Filenames like{' '}
            <code className="text-indigo-300">beat-0.mp4</code> or{' '}
            <code className="text-indigo-300">01.png</code> are auto-mapped automatically!
          </p>
        </div>

        {onClose && (
          <button
            onClick={onClose}
            className="self-start sm:self-center px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-medium transition cursor-pointer"
          >
            ✕ Close Batch
          </button>
        )}
      </div>

      {/* Dropzone Area */}
      {items.length === 0 ? (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-2xl p-8 sm:p-12 text-center transition-all cursor-pointer ${
            isDragging
              ? 'border-indigo-500 bg-indigo-950/20 shadow-lg shadow-indigo-500/10 scale-[1.01]'
              : 'border-zinc-700 hover:border-zinc-600 bg-zinc-950/40'
          }`}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) processFiles(e.target.files);
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is standard in Chromium/Firefox
            webkitdirectory=""
            className="hidden"
            onChange={(e) => {
              if (e.target.files) processFiles(e.target.files);
            }}
          />

          <div className="w-16 h-16 rounded-2xl bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 mx-auto flex items-center justify-center text-3xl mb-4 shadow-inner">
            📁
          </div>

          <h3 className="text-base font-semibold text-white mb-1">
            Drag & drop all visual assets here
          </h3>
          <p className="text-xs text-zinc-400 max-w-md mx-auto mb-5">
            Accepts multiple MP4, MOV, WebM, PNG, JPG, or WebP files. You can drop 10, 50, or 92
            files all at once.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/20 transition cursor-pointer"
            >
              Browse Files (Multi-Select)
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                folderInputRef.current?.click();
              }}
              className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700 transition cursor-pointer"
            >
              Select Folder
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Mapping Controls Bar */}
          <div className="bg-zinc-950/70 border border-zinc-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium text-zinc-400">Mapping Strategy:</span>
              <div className="flex items-center rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
                <button
                  type="button"
                  onClick={() => handleReMap('smart')}
                  disabled={isUploading}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                    mappingMode === 'smart'
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  ⚡ Auto (From Filenames)
                </button>
                <button
                  type="button"
                  onClick={() => handleReMap('sequential')}
                  disabled={isUploading}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                    mappingMode === 'sequential'
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  🔢 Sequential Order
                </button>
              </div>

              {mappingMode === 'sequential' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-400">Start Beat:</span>
                  <input
                    type="number"
                    min={0}
                    max={totalBeats - 1}
                    value={startBeatIndex}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      setStartBeatIndex(isNaN(val) ? 0 : val);
                    }}
                    disabled={isUploading}
                    className="w-16 px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-xs text-white text-center focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => handleReMap('sequential')}
                    disabled={isUploading}
                    className="text-[11px] text-indigo-400 hover:underline"
                  >
                    Reapply
                  </button>
                </div>
              )}

              <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer ml-2">
                <input
                  type="checkbox"
                  checked={skipExisting}
                  onChange={(e) => {
                    setSkipExisting(e.target.checked);
                  }}
                  disabled={isUploading}
                  className="rounded border-zinc-700 text-indigo-600 focus:ring-indigo-500"
                />
                <span>Skip beats with visuals ({existingAssetBeatIndices.size})</span>
              </label>
            </div>

            {/* Quick Actions */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition cursor-pointer"
              >
                + Add More Files
              </button>
              <button
                type="button"
                onClick={handleClearAll}
                disabled={isUploading}
                className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-red-950/40 text-red-400 hover:text-red-300 text-xs font-medium border border-zinc-800 hover:border-red-900/50 transition cursor-pointer"
              >
                Clear Queue
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) processFiles(e.target.files);
                }}
              />
            </div>
          </div>

          {/* Global Provenance / License Defaults */}
          <div className="bg-zinc-950/40 border border-zinc-800/80 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                <span>⚖️</span> Batch License & Provenance Defaults
              </span>
              <button
                type="button"
                onClick={handleApplyDefaults}
                disabled={isUploading}
                className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 cursor-pointer"
              >
                Apply To All Pending Items →
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Default License</label>
                <select
                  value={defaultLicense}
                  onChange={(e) => setDefaultLicense(e.target.value)}
                  disabled={isUploading}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-indigo-500"
                >
                  {LICENSE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">
                  Default Source Note (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. My B-roll folder, Pexels download"
                  value={defaultSourceNote}
                  onChange={(e) => setDefaultSourceNote(e.target.value)}
                  disabled={isUploading}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">
                  Default Attribution (If CC-BY)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Photo by John Doe via Wikimedia"
                  value={defaultAttribution}
                  onChange={(e) => setDefaultAttribution(e.target.value)}
                  disabled={isUploading}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
          </div>

          {/* Summary Status Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs bg-zinc-950/60 p-3 rounded-xl border border-zinc-800">
            <div className="flex items-center gap-4">
              <span className="text-zinc-300">
                Total Files: <strong className="text-white">{items.length}</strong>
              </span>
              <span className="text-emerald-400">
                Mapped: <strong>{validAssignedCount}</strong>
              </span>
              {unassignedCount > 0 && (
                <span className="text-amber-400">
                  Unassigned: <strong>{unassignedCount}</strong>
                </span>
              )}
              {hasCollisions && (
                <span className="text-rose-400">
                  ⚠️ Overlapping beats detected (same beat assigned twice)
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-zinc-400">
                Done: <strong className="text-emerald-400">{uploadedCount}</strong> / {items.length}
              </span>
              {failedCount > 0 && (
                <span className="text-red-400">
                  Failed: <strong>{failedCount}</strong>
                </span>
              )}
            </div>
          </div>

          {/* Progress Bar (Visible when uploading or completed) */}
          {(isUploading || overallProgress > 0) && (
            <div className="space-y-1.5 bg-zinc-950 p-4 rounded-xl border border-zinc-800">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-white flex items-center gap-2">
                  {isUploading && (
                    <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
                  )}
                  {isUploading
                    ? isPaused
                      ? 'Upload Paused'
                      : 'Uploading Visual Assets...'
                    : overallProgress === 100
                      ? '✓ Batch Upload Complete'
                      : 'Batch Upload Progress'}
                </span>
                <span className="font-mono text-indigo-300 font-bold">{overallProgress}%</span>
              </div>
              <div className="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${overallProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Action Trigger Row */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <div className="flex items-center gap-2">
              {!isUploading ? (
                <button
                  type="button"
                  onClick={handleStartBatchUpload}
                  disabled={validAssignedCount === 0}
                  className="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-bold text-xs tracking-wide shadow-lg shadow-indigo-600/30 transition cursor-pointer flex items-center gap-2"
                >
                  <span>🚀</span>
                  <span>
                    Upload {validAssignedCount} {validAssignedCount === 1 ? 'Visual' : 'Visuals'}
                  </span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleTogglePause}
                    className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs transition cursor-pointer"
                  >
                    {isPaused ? '▶ Resume Upload' : '⏸ Pause'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelUpload}
                    className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-red-900/60 text-zinc-300 hover:text-white font-semibold text-xs border border-zinc-700 transition cursor-pointer"
                  >
                    Cancel
                  </button>
                </>
              )}

              {failedCount > 0 && !isUploading && (
                <button
                  type="button"
                  onClick={handleStartBatchUpload}
                  className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-xs transition cursor-pointer"
                >
                  ↺ Retry Failed ({failedCount})
                </button>
              )}
            </div>

            <span className="text-[11px] text-zinc-500">
              Files are processed with 2 parallel threads to avoid network choking.
            </span>
          </div>

          {/* Queue List Table / Grid */}
          <div className="border border-zinc-800 rounded-xl overflow-hidden bg-zinc-950/40 divide-y divide-zinc-800/80 max-h-[480px] overflow-y-auto">
            {items.map((item) => {
              const assignedBeat =
                item.assignedBeatIndex !== null ? beats[item.assignedBeatIndex] : null;
              const hasExistingAsset =
                item.assignedBeatIndex !== null &&
                existingAssetBeatIndices.has(item.assignedBeatIndex);

              return (
                <div
                  key={item.id}
                  className={`p-3 sm:p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 transition ${
                    item.status === 'done'
                      ? 'bg-emerald-950/10'
                      : item.status === 'error'
                        ? 'bg-red-950/20'
                        : item.status === 'uploading'
                          ? 'bg-indigo-950/20'
                          : 'hover:bg-zinc-900/50'
                  }`}
                >
                  {/* File Info & Thumbnail */}
                  <div className="flex items-center gap-3 min-w-0 md:w-2/5">
                    {/* Media Thumbnail */}
                    <div className="w-14 h-10 rounded-lg bg-zinc-800 border border-zinc-700 overflow-hidden flex-shrink-0 flex items-center justify-center relative">
                      {item.previewUrl && item.mimeType.startsWith('image/') ? (
                        <img
                          src={item.previewUrl}
                          alt={item.fileName}
                          className="w-full h-full object-cover"
                        />
                      ) : item.previewUrl && item.mimeType.startsWith('video/') ? (
                        <video
                          src={item.previewUrl}
                          muted
                          preload="metadata"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="text-xs">🎬</span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white truncate" title={item.fileName}>
                          {item.fileName}
                        </span>
                        <span className="text-[10px] text-zinc-500 font-mono">
                          {(item.fileSize / (1024 * 1024)).toFixed(1)} MB
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400 truncate">
                        {item.mimeType || 'binary media'}
                      </p>
                    </div>
                  </div>

                  {/* Beat Target Selector */}
                  <div className="min-w-0 md:w-2/5 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-400 font-medium">Assign to:</span>
                      <select
                        value={item.assignedBeatIndex ?? ''}
                        onChange={(e) => {
                          const val = e.target.value === '' ? null : parseInt(e.target.value, 10);
                          handleItemBeatChange(item.id, val);
                        }}
                        disabled={isUploading || item.status === 'done'}
                        className={`text-xs rounded-lg px-2 py-1 font-semibold focus:outline-none ${
                          item.assignedBeatIndex === null
                            ? 'bg-amber-950/50 border border-amber-700 text-amber-300'
                            : 'bg-zinc-900 border border-zinc-700 text-white'
                        }`}
                      >
                        <option value="">-- Unassigned --</option>
                        {Array.from({ length: totalBeats }, (_, bIdx) => (
                          <option key={bIdx} value={bIdx}>
                            Beat {bIdx + 1} {existingAssetBeatIndices.has(bIdx) ? '(Has Asset)' : ''}
                          </option>
                        ))}
                      </select>

                      {hasExistingAsset && (
                        <span className="text-[10px] text-amber-400 bg-amber-950/40 px-1.5 py-0.5 rounded border border-amber-800">
                          Overwrites existing
                        </span>
                      )}
                    </div>

                    {assignedBeat && (
                      <p
                        className="text-[11px] text-zinc-400 truncate italic"
                        title={assignedBeat.narration || assignedBeat.text}
                      >
                        &ldquo;{(assignedBeat.narration || assignedBeat.text || '').slice(0, 70)}
                        &hellip;&rdquo;
                      </p>
                    )}
                  </div>

                  {/* Status & Actions */}
                  <div className="flex items-center justify-between md:justify-end gap-3 min-w-0 md:w-1/5">
                    {/* Status Badge */}
                    <div>
                      {item.status === 'done' ? (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-950/60 border border-emerald-700 text-emerald-300 flex items-center gap-1">
                          <span>✓</span> Uploaded
                        </span>
                      ) : item.status === 'uploading' ? (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-950/60 border border-indigo-700 text-indigo-300 flex items-center gap-1 animate-pulse">
                          <span>⏳</span> Uploading...
                        </span>
                      ) : item.status === 'error' ? (
                        <span
                          className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-950/60 border border-red-700 text-red-300"
                          title={item.error}
                        >
                          ✕ Failed
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-800 text-zinc-400">
                          Ready
                        </span>
                      )}
                    </div>

                    {/* Delete item button */}
                    {item.status !== 'uploading' && (
                      <button
                        type="button"
                        onClick={() => handleRemoveItem(item.id)}
                        disabled={isUploading}
                        className="text-zinc-500 hover:text-red-400 p-1 transition cursor-pointer"
                        title="Remove file from queue"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
