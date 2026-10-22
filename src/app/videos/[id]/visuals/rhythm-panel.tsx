'use client';

import React, { useEffect, useState } from 'react';
import type { RhythmReport } from '@/lib/script/visual-rhythm';

const RISK_STYLE: Record<RhythmReport['risk'], string> = {
  low: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
  medium: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
  high: 'bg-red-500/10 border-red-500/30 text-red-300',
};
const RISK_LABEL: Record<RhythmReport['risk'], string> = {
  low: 'Low slideshow risk',
  medium: 'Some repetition',
  high: 'Slideshow risk',
};

const pct = (n?: number) => (n === undefined ? '—' : `${Math.round(n * 100)}%`);

function ReportBlock({ title, report }: { title: string; report: RhythmReport }) {
  const remaining = report.issues.filter((i) => !i.fixed);
  const fixed = report.issues.filter((i) => i.fixed);
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3.5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-zinc-200">{title}</span>
        <span className="flex items-center gap-2">
          <span className="text-lg font-bold text-white tabular-nums">{report.score}</span>
          <span className="text-zinc-500">/ 100</span>
          <span className={`text-[10px] px-2 py-0.5 rounded-full border ${RISK_STYLE[report.risk]}`}>{RISK_LABEL[report.risk]}</span>
        </span>
      </div>
      <p className="text-zinc-400 tabular-nums">
        {report.shots} shots · footage {pct(report.footageShare)} · graphics {pct(report.graphicsShare)} · text cards {pct(report.textShare)}
        {report.stage === 'render' ? ` · stills ${pct(report.stillShare)}` : ''}
      </p>
      {remaining.length === 0 ? (
        <p className="text-emerald-300">No repetitive stretches found.</p>
      ) : (
        <ul className="space-y-1 text-amber-200/90 list-disc pl-4">
          {remaining.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}
      {fixed.length > 0 && (
        <details className="text-zinc-500">
          <summary className="cursor-pointer">Fixed automatically when the shots were planned ({fixed.length})</summary>
          <ul className="mt-1 space-y-1 list-disc pl-4">
            {fixed.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Visual rhythm (slideshow risk): whether the video's picture stays varied, shown for the shot
 * plan and, once rendered, for what was actually rendered. `refreshKey` reloads it (e.g. after a
 * shot is swapped).
 */
export function RhythmPanel({ videoId, refreshKey, only }: { videoId: string; refreshKey?: number; only?: 'plan' }) {
  const [data, setData] = useState<{ plan: RhythmReport | null; render: RhythmReport | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/videos/${videoId}/rhythm`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled && json) setData({ plan: json.plan ?? null, render: json.render ?? null });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [videoId, refreshKey]);

  const render = only === 'plan' ? null : data?.render;
  const plan = data?.plan;
  if (!render && !plan) return null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3 text-xs">
      <div>
        <span className="text-sm font-bold text-white">🎞️ Visual rhythm</span>
        <p className="text-zinc-400 mt-0.5">
          Checks the whole video for slideshow-like stretches: graphics or text cards back to back, one type crowding a stretch, or
          too many still photos in a row.
        </p>
      </div>
      <div className={`grid gap-3 ${render && plan ? 'md:grid-cols-2' : ''}`}>
        {render && <ReportBlock title="Rendered visuals" report={render} />}
        {plan && <ReportBlock title="Shot plan" report={plan} />}
      </div>
    </div>
  );
}
