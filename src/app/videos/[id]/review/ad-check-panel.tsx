'use client';

import React, { useState } from 'react';
import type { ScriptBeat } from '@/lib/script/generate-script';
import { AD_CATEGORY_LABEL, type AdCheckIssue, type AdCheckReport } from '@/lib/script/ad-check-issues';
import { openIssues } from '@/lib/script/fact-check-issues';
import { IssueCard, dismissIssue } from './issue-card';

/** Summary of the advertiser-friendly check, title problems, and a button to run it again. */
export function AdCheckPanel({
  videoId,
  report,
  beats,
  onReport,
}: {
  videoId: string;
  report: AdCheckReport | undefined;
  beats: ScriptBeat[];
  onReport: (report: AdCheckReport) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/script/ad-check`, {
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

  const open = openIssues<AdCheckIssue>(report, beats);
  const limited = open.filter((i) => i.severity === 'limited').length;
  const titleIssues = report?.titleIssues ?? [];

  return (
    <div className="rounded-xl bg-zinc-950/60 border border-zinc-800 text-xs p-3.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-zinc-200 font-semibold">
          💲 Ad-friendly
          <span className="font-normal text-zinc-400">
            {!report
              ? ' · not checked yet'
              : report.localOnly
                ? ' · only swearing was checked (the full check failed; try again)'
                : ` · ${report.beatsChecked} beats checked`}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {report && limited > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/30 text-red-300 font-medium">
              {limited} likely to limit ads
            </span>
          )}
          {report && open.length - limited > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-violet-500/10 border border-violet-500/30 text-violet-300 font-medium">
              {open.length - limited} borderline
            </span>
          )}
          {report && open.length === 0 && titleIssues.length === 0 && (
            <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-medium">
              ✓ Looks ad-friendly
            </span>
          )}
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 cursor-pointer disabled:opacity-50"
          >
            {running ? 'Checking…' : report ? 'Check again' : 'Check'}
          </button>
        </span>
      </div>
      {titleIssues.length > 0 && (
        <ul className="space-y-1 text-zinc-300">
          {titleIssues.map((t) => (
            <li key={t.title}>
              <span className="text-violet-300 font-semibold">Title</span> “{t.title}”: {t.problem}
              {t.suggestion && <span className="text-zinc-400 italic"> Try: “{t.suggestion}”</span>}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-red-300">{error}</p>}
    </div>
  );
}

/** The open ad-friendly issues on one beat. */
export function BeatAdIssues({
  videoId,
  beat,
  report,
  onReport,
  onUseSuggestion,
  onRewrite,
}: {
  videoId: string;
  beat: ScriptBeat;
  report: AdCheckReport | undefined;
  onReport: (report: AdCheckReport) => void;
  onUseSuggestion: (text: string) => void;
  onRewrite: (instruction: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const issues = openIssues<AdCheckIssue>(report, [beat]);
  if (issues.length === 0) return null;

  async function dismiss(issue: AdCheckIssue) {
    setBusy(issue.id);
    try {
      const updated = await dismissIssue<AdCheckReport>(`/api/videos/${videoId}/script/ad-check`, issue.id);
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
          tone={issue.severity === 'limited' ? 'red' : 'violet'}
          heading={`💲 ${AD_CATEGORY_LABEL[issue.category]}${issue.severity === 'limited' ? ': likely limited ads' : ': borderline'}`}
          quote={issue.quote}
          problem={issue.problem}
          suggestion={issue.suggested_text}
          onUseSuggestion={onUseSuggestion}
          onRewrite={() =>
            onRewrite(`Make this advertiser-friendly for YouTube: ${issue.problem} Keep the facts and the tension; imply rather than describe.`)
          }
          onDismiss={() => dismiss(issue)}
          dismissLabel="Keep as is"
          busy={busy === issue.id}
        />
      ))}
    </div>
  );
}
