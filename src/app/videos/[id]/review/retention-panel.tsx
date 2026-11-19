'use client';

import React, { useState } from 'react';
import type { ScriptBeat } from '@/lib/script/generate-script';
import {
  RETENTION_KIND_LABEL,
  openRetentionIssues,
  type RetentionIssue,
  type RetentionReport,
} from '@/lib/script/retention-types';
import { IssueCard, dismissIssue } from './issue-card';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const scrollToBeat = (i: number) => document.getElementById(`beat-card-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

function scoreTone(score: number) {
  if (score >= 70) return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300';
  if (score >= 50) return 'bg-amber-500/10 border-amber-500/30 text-amber-300';
  return 'bg-red-500/10 border-red-500/30 text-red-300';
}

/** Interest across the video's timeline, with section starts and the beats that have problems. */
function InterestChart({ report, open }: { report: RetentionReport; open: RetentionIssue[] }) {
  const W = 1000;
  const H = 120;
  const total = Math.max(1, report.totalSeconds);
  const x = (i: number) => ((report.starts[i] ?? 0) / total) * W;
  const y = (interest: number) => H - 14 - ((interest - 1) / 4) * (H - 28);
  const points = report.marks.map((m) => `${x(m.beat_index).toFixed(1)},${y(m.interest).toFixed(1)}`).join(' ');
  const worst = new Map<number, RetentionIssue['severity']>();
  for (const i of open) if (worst.get(i.beat_index) !== 'high') worst.set(i.beat_index, i.severity);
  return (
    <div className="space-y-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28" preserveAspectRatio="none" role="img" aria-label="Interest across the video">
        {[1, 3, 5].map((v) => (
          <line key={v} x1={0} x2={W} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-zinc-800" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {report.marks.filter((m) => m.section_start && m.beat_index > 0).map((m) => (
          <line key={`s${m.beat_index}`} x1={x(m.beat_index)} x2={x(m.beat_index)} y1={0} y2={H} stroke="currentColor" className="text-sky-700" strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        <polyline points={points} fill="none" stroke="currentColor" className="text-zinc-300" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      {/* Problem markers as buttons (an SVG can't host accessible buttons that stay round when stretched) */}
      <div className="relative h-5">
        {[...worst.entries()].map(([beat, sev]) => (
          <button
            key={beat}
            type="button"
            onClick={() => scrollToBeat(beat)}
            title={`Beat ${beat + 1} at ${clock(report.starts[beat] ?? 0)}`}
            style={{ left: `${(x(beat) / W) * 100}%` }}
            className={`absolute -translate-x-1/2 w-3 h-3 rounded-full border cursor-pointer ${sev === 'high' ? 'bg-red-500 border-red-300' : 'bg-amber-400 border-amber-200'}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-zinc-500">
        <span>0:00</span>
        <span>Interest per beat (1–5) · dashed lines: new sections · dots: problems (click to jump)</span>
        <span>{clock(report.totalSeconds)}</span>
      </div>
    </div>
  );
}

/** The retention check: score, promise, interest chart, open questions, and "use all suggestions". */
export function RetentionPanel({
  videoId,
  report,
  beats,
  onReport,
  onUseAll,
}: {
  videoId: string;
  report: RetentionReport | undefined;
  beats: ScriptBeat[];
  onReport: (report: RetentionReport) => void;
  /** Applies every open issue's suggested rewrite (each can be undone on its beat). */
  onUseAll: (fixes: Array<{ beatIndex: number; text: string }>) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLoops, setShowLoops] = useState(false);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/script/retention`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ beats }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      onReport(data.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const open = openRetentionIssues(report, beats);
  const high = open.filter((i) => i.severity === 'high').length;
  const fixes = [...new Map(open.filter((i) => i.suggested_text).map((i) => [i.beat_index, i.suggested_text!])).entries()].map(([beatIndex, text]) => ({ beatIndex, text }));
  const stale = report ? report.beatsChecked !== beats.length || report.issues.some((i) => beats[i.beat_index]?.text !== i.checked_text) : false;
  const promise = report?.promise;
  const unanswered = report?.loops.filter((l) => l.closed_at == null).length ?? 0;

  return (
    <div className="rounded-xl bg-zinc-950/60 border border-zinc-800 text-xs p-3.5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-zinc-200 font-semibold">
          📈 Retention
          <span className="font-normal text-zinc-400">
            {!report ? ' · not checked yet' : ` · ${report.beatsChecked} beats, about ${clock(report.totalSeconds)}${stale ? ' · the script changed since the check' : ''}`}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {report && (
            <span className={`px-2 py-0.5 rounded-full border font-semibold ${scoreTone(report.score)}`} title="An estimate from how gripping each beat is and the problems found, not a prediction of real watch time">
              {report.score}/100
            </span>
          )}
          {report && high > 0 && <span className="px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/30 text-red-300 font-medium">{high} serious</span>}
          {report && open.length - high > 0 && <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 font-medium">{open.length - high} to improve</span>}
          {fixes.length > 0 && (
            <button type="button" onClick={() => onUseAll(fixes)} className="px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white font-semibold cursor-pointer">
              Use all {fixes.length} suggestion{fixes.length > 1 ? 's' : ''}
            </button>
          )}
          <button type="button" onClick={run} disabled={running} className="px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 cursor-pointer disabled:opacity-50">
            {running ? 'Checking…' : report ? 'Check again' : 'Check'}
          </button>
        </span>
      </div>

      {report && (
        <>
          {promise && (
            <p className="text-zinc-300">
              <span className={`font-semibold ${promise.status === 'paid' ? 'text-emerald-300' : promise.status === 'partial' ? 'text-amber-300' : 'text-red-300'}`}>
                {promise.status === 'paid' ? '✓ Promise paid off' : promise.status === 'partial' ? '◐ Promise partly paid off' : '✗ Promise not paid off'}
              </span>{' '}
              {promise.paid_at != null && (
                <button type="button" onClick={() => scrollToBeat(promise.paid_at!)} className="text-zinc-400 hover:text-zinc-200 underline decoration-dotted cursor-pointer">
                  at {clock(report.starts[promise.paid_at] ?? 0)} (beat {promise.paid_at + 1})
                </button>
              )}
              <span className="text-zinc-400"> · “{promise.promise}”{promise.note ? ` ${promise.note}` : ''}</span>
            </p>
          )}
          <InterestChart report={report} open={open} />
          <div>
            <button type="button" onClick={() => setShowLoops((v) => !v)} className="text-zinc-400 hover:text-zinc-200 cursor-pointer">
              {showLoops ? '▾' : '▸'} {report.loops.length} open question{report.loops.length === 1 ? '' : 's'} keeping viewers watching{unanswered ? ` (${unanswered} never answered)` : ''}
            </button>
            {showLoops && (
              <ul className="mt-1.5 space-y-1 pl-4">
                {report.loops.map((l, k) => (
                  <li key={k} className="text-zinc-300">
                    “{l.question}” <span className="text-zinc-500">raised at {clock(report.starts[l.opened_at] ?? 0)}, {l.closed_at == null ? <span className="text-amber-300">never answered</span> : `answered at ${clock(report.starts[l.closed_at] ?? 0)}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {error && <p className="text-red-300">{error}</p>}
    </div>
  );
}

/** The open retention problems on one beat. */
export function BeatRetentionIssues({
  videoId,
  beat,
  report,
  onReport,
  onUseSuggestion,
  onRewrite,
}: {
  videoId: string;
  beat: ScriptBeat;
  report: RetentionReport | undefined;
  onReport: (report: RetentionReport) => void;
  onUseSuggestion: (text: string) => void;
  onRewrite: (instruction: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const issues = openRetentionIssues(report, [beat]);
  if (issues.length === 0) return null;

  async function dismiss(issue: RetentionIssue) {
    setBusy(issue.id);
    try {
      const updated = await dismissIssue<RetentionReport>(`/api/videos/${videoId}/script/retention`, issue.id);
      if (updated) onReport(updated);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-1.5">
      {issues.map((issue) => (
        <IssueCard
          key={issue.id}
          tone={issue.severity === 'high' ? 'red' : 'amber'}
          heading={`📈 ${RETENTION_KIND_LABEL[issue.kind]}`}
          problem={issue.problem}
          suggestion={issue.suggested_text}
          onUseSuggestion={onUseSuggestion}
          onRewrite={() => onRewrite(issue.fix_instruction)}
          onDismiss={() => dismiss(issue)}
          dismissLabel="Keep as is"
          busy={busy === issue.id}
        />
      ))}
    </div>
  );
}
