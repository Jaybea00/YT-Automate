'use client';

import React, { use, useCallback, useEffect, useState } from 'react';
import { PageContainer, PageHeader, EmptyState } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Shot {
  beatIndex: number;
  shotIndex: number;
  order: number;
  startSec: number;
  durationSec: number;
  renderedType: string;
  plannedType: string;
  covers: string;
  query: string;
  sourceUrl: string | null;
  still: boolean;
  fallback: boolean;
  needsCheck: boolean;
  note: string | null;
  alternatives: number;
}
interface Issue {
  order: number;
  beatIndex: number;
  shotIndex: number;
  kind: 'duplicate' | 'era_jump' | 'long_still' | 'text_or_logo' | 'gap' | 'needs_check' | 'reused';
  severity: 'high' | 'medium' | 'info';
  detail: string;
}
interface Review {
  reviewedAt: string;
  shotsReviewed: number;
  issues: Issue[];
  textCheck: boolean;
}
interface Board {
  shots: Shot[];
  missingBeats: number[];
  review: Review | null;
}

const LABEL: Record<Issue['kind'], string> = {
  duplicate: 'Same as the shot before',
  era_jump: 'B&W next to colour',
  long_still: 'Still held too long',
  text_or_logo: 'Text or logo',
  gap: 'Shown as type',
  needs_check: 'Not checked yet',
  reused: 'Used in other videos',
};
const TONE: Record<Issue['severity'], string> = {
  high: 'bg-red-500/15 text-red-300 border-red-500/30',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  info: 'bg-zinc-800 text-zinc-300 border-zinc-700',
};
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const key = (b: number, s: number) => `${b}.${s}`;

/**
 * The whole video as a storyboard: every shot in order with the words it plays under, and a
 * review of problems only visible across shots, each with a one-click fix.
 */
export default function StoryboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [board, setBoard] = useState<Board | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [fixed, setFixed] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const fetchBoard = useCallback(() => fetch(`/api/videos/${id}/storyboard`, { cache: 'no-store' }).then((r) => r.json() as Promise<Board & { error?: string }>), [id]);

  useEffect(() => {
    let cancelled = false;
    fetchBoard()
      .then((b) => {
        if (!cancelled) setBoard(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchBoard]);

  async function review() {
    setReviewing(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${id}/storyboard`, { method: 'POST' });
      const json = (await res.json()) as Board & { error?: string };
      if (!res.ok) throw new Error(json.error || 'Review failed');
      setBoard(json);
      setFixed(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewing(false);
    }
  }

  async function fix(shot: Shot, action: 'swap' | 'redo' | 'text') {
    const k = key(shot.beatIndex, shot.shotIndex);
    setBusy(k);
    setError(null);
    try {
      let body: Record<string, unknown> = { action };
      if (action === 'swap') {
        const list = (await (await fetch(`/api/videos/${id}/beats/${shot.beatIndex}/shots`)).json()) as { shots?: Array<{ alternatives?: unknown[] }> };
        const candidate = list.shots?.[shot.shotIndex]?.alternatives?.[0];
        if (!candidate) throw new Error('This shot has no other candidates; try "Pick again".');
        body = { action: 'swap', candidate };
      }
      const res = await fetch(`/api/videos/${id}/beats/${shot.beatIndex}/shots/${shot.shotIndex}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || 'The fix failed');
      setFixed((f) => new Set(f).add(k));
      setTick((t) => t + 1);
      const next = await fetchBoard();
      setBoard((b) => (b ? { ...next, review: b.review } : next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!board)
    return (
      <PageContainer width="full">
        <EmptyState loading title="Loading the storyboard…" />
      </PageContainer>
    );

  const issuesFor = (s: Shot) => (board.review?.issues ?? []).filter((i) => i.beatIndex === s.beatIndex && i.shotIndex === s.shotIndex);
  const counts = { high: 0, medium: 0, info: 0 };
  for (const i of board.review?.issues ?? []) if (!fixed.has(key(i.beatIndex, i.shotIndex))) counts[i.severity]++;
  const visible = onlyIssues ? board.shots.filter((s) => issuesFor(s).some((i) => i.severity !== 'info') && !fixed.has(key(s.beatIndex, s.shotIndex))) : board.shots;

  return (
    <PageContainer width="full">
        <PageHeader
          title="Storyboard"
          description={`${board.shots.length} shots${board.missingBeats.length ? ` · ${board.missingBeats.length} beat${board.missingBeats.length === 1 ? '' : 's'} without a shot plan (not shown)` : ''}`}
          meta={
            board.review && (
              <>
                <span>Reviewed {new Date(board.review.reviewedAt).toLocaleString()}</span>
                <Badge tone="danger">{counts.high} serious</Badge>
                <Badge tone="warning">{counts.medium} to improve</Badge>
                <Badge>{counts.info} notes</Badge>
                {!board.review.textCheck && <span>Text and logo check skipped</span>}
              </>
            )
          }
          actions={
            <>
              <label className="inline-flex h-10 items-center gap-2 rounded-xl border border-zinc-800 px-3 text-sm text-zinc-300">
                <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} className="accent-indigo-500" /> Problems only
              </label>
              <Button variant="primary" icon="eye" onClick={review} disabled={reviewing || !board.shots.length}>
                {reviewing ? `Reviewing ${board.shots.length} shots…` : board.review ? 'Review again' : 'Review the storyboard'}
              </Button>
            </>
          }
        />

        {reviewing && <p className="text-xs text-amber-300">Each shot&apos;s frame is measured once and remembered; the first review of a long video takes a minute or two.</p>}
        {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}
        {!board.shots.length && <p className="text-sm text-zinc-500">No rendered shots yet. Source the visuals first.</p>}

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {visible.map((s) => {
            const k = key(s.beatIndex, s.shotIndex);
            const issues = fixed.has(k) ? [] : issuesFor(s);
            const flagged = issues.some((i) => i.severity !== 'info');
            return (
              <div key={k} id={`shot-${k}`} className={`rounded-xl border overflow-hidden bg-zinc-900/60 flex flex-col ${flagged ? 'border-amber-600/60' : 'border-zinc-800'}`}>
                <div className="relative aspect-video bg-zinc-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/videos/${id}/storyboard/thumb?beat=${s.beatIndex}&shot=${s.shotIndex}&v=${tick}`} alt="" loading="lazy" className="w-full h-full object-cover" />
                  <span className="absolute top-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70">#{s.order + 1} · {clock(s.startSec)}</span>
                  <span className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70">
                    {s.renderedType}
                    {s.still ? ' (still)' : ''}
                  </span>
                  <span className="absolute bottom-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70">{s.durationSec.toFixed(1)}s</span>
                  {fixed.has(k) && <span className="absolute bottom-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-700/90">changed: review again</span>}
                </div>
                <div className="p-2 space-y-1.5 flex-1 flex flex-col">
                  <p className="text-[11px] text-zinc-300 line-clamp-2" title={s.covers}>
                    “{s.covers}”
                  </p>
                  {issues.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {issues.map((i) => (
                        <span key={i.kind} className={`text-[10px] px-1.5 py-0.5 rounded-full border ${TONE[i.severity]}`} title={i.detail}>
                          {LABEL[i.kind]}
                        </span>
                      ))}
                    </div>
                  )}
                  {flagged && (
                    <div className="flex flex-wrap gap-1 pt-0.5 mt-auto">
                      {s.alternatives > 0 && (
                        <button type="button" disabled={busy !== null} onClick={() => fix(s, 'swap')} className="text-[10px] px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40">
                          Swap
                        </button>
                      )}
                      <button type="button" disabled={busy !== null} onClick={() => fix(s, 'redo')} className="text-[10px] px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40">
                        Pick again
                      </button>
                      <button type="button" disabled={busy !== null} onClick={() => fix(s, 'text')} className="text-[10px] px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40">
                        As text
                      </button>
                      {busy === k && <span className="text-[10px] text-amber-300">Working…</span>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {onlyIssues && visible.length === 0 && board.review && <p className="text-sm text-emerald-300">No problems left in this review.</p>}
    </PageContainer>
  );
}
