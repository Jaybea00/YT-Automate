'use client';

import React, { useState } from 'react';
import type { ScriptBeat } from '@/lib/script/generate-script';

/**
 * Replacing the script's beats with pasted text or timed SRT subtitles: the dialog keeps its own
 * text and options, sends the import, and hands the new beats back to the page.
 */
export function ImportScriptDialog({
  videoId,
  onClose,
  onImported,
}: {
  videoId: string;
  onClose: () => void;
  onImported: (beats: ScriptBeat[] | null) => void | Promise<void>;
}) {
  const [importTab, setImportTab] = useState<'raw' | 'srt'>('raw');
  const [importRawText, setImportRawText] = useState('');
  const [importRawMode, setImportRawMode] = useState<'raw_paragraphs' | 'raw_ai'>('raw_paragraphs');
  const [importSrtText, setImportSrtText] = useState('');
  const [importSmartMerge, setImportSmartMerge] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  async function handleImportScript() {
    setIsImporting(true);
    setImportError(null);
    try {
      const payload: Record<string, unknown> = { mode: importTab === 'srt' ? 'srt' : importRawMode };
      if (importTab === 'srt') {
        if (!importSrtText.trim()) throw new Error('Please provide SRT subtitle content.');
        payload.srtText = importSrtText.trim();
        payload.minBeatDurationSeconds = importSmartMerge ? 4.0 : 0;
      } else {
        if (!importRawText.trim()) throw new Error('Please provide script text.');
        payload.rawText = importRawText.trim();
      }
      const res = await fetch(`/api/videos/${videoId}/script/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to import script');
      await onImported(json.script?.beats ?? null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsImporting(false);
    }
  }

  return (
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
              onClick={() => onClose()}
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
              onClick={() => onClose()}
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
  );
}
