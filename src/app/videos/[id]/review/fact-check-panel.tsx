'use client';

import React, { useState } from 'react';
import type { ScriptBeat } from '@/lib/script/generate-script';
import { IssueCard, dismissIssue } from './issue-card';
import { FACT_CHECK_LABEL, openIssues, type FactCheckIssue, type FactCheckReport } from '@/lib/script/fact-check-issues';

/** Summary of the independent fact-check, with a button to run it again on the current beats. */
export function FactCheckPanel({
  videoId,
  report,
  beats,
  onReport,
}: {
  videoId: string;
  report: FactCheckReport | undefined;
  beats: ScriptBeat[];
  onReport: (report: FactCheckReport) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/script/fact-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beats }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      onReport(data.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const open = openIssues(report, beats);
  const living = open.filter((i) => i.kind === 'living_person').length;
  const factual = open.length - living;
  const edited = report ? report.issues.filter((i) => !i.dismissed).length - open.length : 0;

  return (
    <div className="rounded-xl bg-zinc-950/60 border border-zinc-800 text-xs p-3.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-zinc-200 font-semibold">
          🔎 Fact-check
          <span className="font-normal text-zinc-400">
            {report
              ? ` · ${report.beatsChecked} beats checked${report.model ? ` by ${report.model}` : ''}${report.hadResearch ? '' : ' (no research: general knowledge only)'}`
              : ' · not run yet'}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {report && factual > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/30 text-red-300 font-medium">
              {factual} factual issue{factual === 1 ? '' : 's'}
            </span>
          )}
          {report && living > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 font-medium">
              {living} about living people
            </span>
          )}
          {report && open.length === 0 && (
            <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-medium">
              ✓ Nothing open
            </span>
          )}
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 cursor-pointer disabled:opacity-50"
          >
            {running ? 'Checking…' : report ? 'Check again' : 'Fact-check'}
          </button>
        </span>
      </div>
      {edited > 0 && (
        <p className="text-zinc-500">
          {edited} earlier issue{edited === 1 ? ' is' : 's are'} hidden because the beat was edited. Check again to re-verify.
        </p>
      )}
      {error && <p className="text-red-300">{error}</p>}
    </div>
  );
}

/** The open fact-check issues on one beat, each with its suggested wording. */
export function BeatFactIssues({
  videoId,
  beat,
  report,
  onReport,
  onUseSuggestion,
}: {
  videoId: string;
  beat: ScriptBeat;
  report: FactCheckReport | undefined;
  onReport: (report: FactCheckReport) => void;
  onUseSuggestion: (text: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const issues = openIssues(report, [beat]);
  if (issues.length === 0) return null;

  async function dismiss(issue: FactCheckIssue) {
    setBusy(issue.id);
    try {
      const updated = await dismissIssue<FactCheckReport>(`/api/videos/${videoId}/script/fact-check`, issue.id);
      if (updated) onReport(updated);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-1.5">
      {issues.map((issue) => {
        const living = issue.kind === 'living_person';
        return (
          <IssueCard
            key={issue.id}
            tone={living ? 'amber' : 'red'}
            heading={living ? `⚠ Living person${issue.person ? `: ${issue.person}` : ''}` : `✗ ${FACT_CHECK_LABEL[issue.kind]}`}
            quote={issue.claim}
            problem={issue.problem}
            suggestion={issue.suggested_text}
            onUseSuggestion={onUseSuggestion}
            onDismiss={() => dismiss(issue)}
            dismissLabel={living ? 'Checked, keep it' : 'Dismiss'}
            busy={busy === issue.id}
          />
        );
      })}
    </div>
  );
}
