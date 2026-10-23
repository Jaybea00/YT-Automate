'use client';

import React from 'react';

const TONES = {
  red: { box: 'bg-red-950/20 border-red-800/50 text-red-100', heading: 'text-red-300' },
  amber: { box: 'bg-amber-950/20 border-amber-800/50 text-amber-100', heading: 'text-amber-300' },
  violet: { box: 'bg-violet-950/20 border-violet-800/50 text-violet-100', heading: 'text-violet-300' },
} as const;

const button =
  'px-2 py-0.5 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 cursor-pointer disabled:opacity-50';

/** One flagged problem on a beat (fact-check, ad-friendly check), with its fixes. */
export function IssueCard({
  tone,
  heading,
  quote,
  problem,
  suggestion,
  onUseSuggestion,
  onRewrite,
  onDismiss,
  dismissLabel = 'Dismiss',
  busy = false,
}: {
  tone: keyof typeof TONES;
  heading: string;
  quote?: string;
  problem: string;
  suggestion?: string;
  onUseSuggestion?: (text: string) => void;
  /** Opens the beat rewriter when there's no ready-made suggestion. */
  onRewrite?: () => void;
  onDismiss: () => void;
  dismissLabel?: string;
  busy?: boolean;
}) {
  const t = TONES[tone];
  return (
    <div className={`p-2.5 rounded-lg border text-[11px] space-y-1 ${t.box}`}>
      <p>
        <span className={`font-semibold ${t.heading}`}>{heading}</span>
        {quote && <span className="text-zinc-400"> · “{quote}”</span>}
      </p>
      <p className="text-zinc-300">{problem}</p>
      {suggestion && <p className="text-zinc-400 italic">Suggested: {suggestion}</p>}
      <div className="flex gap-2 pt-0.5">
        {suggestion && onUseSuggestion && (
          <button type="button" onClick={() => onUseSuggestion(suggestion)} className={`${button} text-zinc-200`}>
            Use suggested wording
          </button>
        )}
        {!suggestion && onRewrite && (
          <button type="button" onClick={onRewrite} className={`${button} text-zinc-200`}>
            Rewrite this beat
          </button>
        )}
        <button type="button" onClick={onDismiss} disabled={busy} className={`${button} text-zinc-400`}>
          {dismissLabel}
        </button>
      </div>
    </div>
  );
}

/** Marks an issue dismissed through a check's PATCH route; returns the updated report or null. */
export async function dismissIssue<R>(url: string, issueId: string): Promise<R | null> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueId, dismissed: true }),
  });
  const data = await res.json().catch(() => null);
  return res.ok && data ? (data.report as R) : null;
}
