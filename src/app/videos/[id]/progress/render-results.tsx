'use client';

import React from 'react';
import { formatDuration, type RenderReport } from '@/pipeline/runner/render-report';

/**
 * The render page's results: the quick preview, how the last full render reused beats, the
 * final quality check (and what it fixed) and the render report.
 */

export type PreviewInfo = { renderedAt: string | null; error: string | null; rebuiltBeats?: number[]; beats?: number };
export type LastRender = { renderedAt?: string; rebuiltBeats?: number[]; beats?: unknown[] };
export type QualityReportView = {
  passed: boolean;
  checkedAt: string;
  checks: Array<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
  fixed?: Array<{ id: string; detail: string }>;
};

const rebuildNote = (rebuilt: number[] | undefined, total: number | undefined) =>
  rebuilt && total
    ? rebuilt.length >= total
      ? `All ${total} beats rendered fresh.`
      : rebuilt.length === 0
        ? `Nothing changed: all ${total} beats reused.`
        : `Rebuilt ${rebuilt.length} of ${total} beats (${rebuilt.map((b) => b + 1).join(', ')}); the rest reused.`
    : null;

export function RenderResults({
  id,
  preview,
  lastRender,
  qualityReport,
  renderReport,
}: {
  id: string;
  preview?: PreviewInfo;
  lastRender?: LastRender;
  qualityReport?: QualityReportView;
  renderReport?: RenderReport;
}) {
  return (
    <>
      {/* Final quality check on the rendered video */}
      {rebuildNote(lastRender?.rebuiltBeats, lastRender?.beats?.length) && (
        <p className="text-xs text-zinc-500 px-1">
          Last full render: {rebuildNote(lastRender?.rebuiltBeats, lastRender?.beats?.length)} Change a shot and render again: only the beats you changed are rebuilt.
        </p>
      )}

      {preview && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">⚡ Quick preview</h2>
            <span className="text-[11px] text-zinc-500">
              {preview.renderedAt ? `made ${new Date(preview.renderedAt).toLocaleString()}` : 'failed'}
            </span>
          </div>
          {preview.renderedAt ? (
            <video
              src={`/api/videos/${id}/render?preview=1&v=${encodeURIComponent(preview.renderedAt)}`}
              controls
              preload="metadata"
              className="w-full max-w-2xl rounded-lg border border-zinc-800 bg-black"
            />
          ) : (
            <p className="text-xs text-red-300">{preview.error}</p>
          )}
          {rebuildNote(preview.rebuiltBeats, preview.beats) && (
            <p className="text-[11px] text-zinc-400">{rebuildNote(preview.rebuiltBeats, preview.beats)}</p>
          )}
          <p className="text-[11px] text-zinc-500">Small and fast: cuts instead of transitions, no emphasis effects. Music, sound effects and captions are as in the final. Start Assembly for the real thing.</p>
        </div>
      )}
      {qualityReport && qualityReport.checks.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-8 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Final Quality Check</h2>
            <span
              className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${
                qualityReport.passed
                  ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                  : 'bg-red-950 text-red-300 border-red-800'
              }`}
            >
              {qualityReport.passed ? '✓ Ready to upload' : '✗ Needs attention'}
            </span>
          </div>
          <ul className="divide-y divide-zinc-800/80">
            {qualityReport.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-3 py-2 text-sm">
                <span className={c.status === 'pass' ? 'text-emerald-400' : c.status === 'warn' ? 'text-amber-400' : 'text-red-400'}>
                  {c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✗'}
                </span>
                <span className="text-zinc-200 font-medium min-w-[14rem]">{c.label}</span>
                <span className="text-zinc-400 text-xs pt-0.5">{c.detail}</span>
              </li>
            ))}
          </ul>
          {qualityReport.fixed && qualityReport.fixed.length > 0 && (
            <div className="rounded-xl border border-sky-900 bg-sky-950/40 p-3 space-y-1">
              <p className="text-xs font-semibold text-sky-300">Fixed automatically before this check</p>
              {qualityReport.fixed.map((f) => (
                <p key={f.id} className="text-xs text-zinc-300">{f.detail}</p>
              ))}
            </div>
          )}
          <p className="text-[11px] text-zinc-500">
            Checked {new Date(qualityReport.checkedAt).toLocaleString()}. Intended dips at chapter changes and the closing fade are not flagged.
          </p>
        </div>
      )}
      {renderReport && renderReport.phases.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-8 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Render Report</h2>
            <span className="text-xs text-zinc-400">{formatDuration(renderReport.totalSec)} in all</span>
          </div>
          <div className="space-y-1.5">
            {renderReport.phases.map((p) => (
              <div key={p.phase} className="flex items-center gap-3 text-xs">
                <span className="w-56 shrink-0 text-zinc-300">{p.label}</span>
                <div className="flex-1 h-2 rounded bg-zinc-800 overflow-hidden">
                  <div className="h-full bg-indigo-500" style={{ width: `${renderReport.totalSec ? Math.max(1, (p.sec / renderReport.totalSec) * 100) : 0}%` }} />
                </div>
                <span className="w-16 text-right text-zinc-400 tabular-nums">{formatDuration(p.sec)}</span>
              </div>
            ))}
          </div>
          <ul className="space-y-1 text-xs text-zinc-400 list-disc pl-4">
            {renderReport.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {renderReport.endScreenSec > 0 && <li>End screen: {Math.round(renderReport.endScreenSec)}s after the last line.</li>}
          </ul>
          <p className="text-[11px] text-zinc-500">Rendered {new Date(renderReport.renderedAt).toLocaleString()}.</p>
        </div>
      )}
    </>
  );
}
