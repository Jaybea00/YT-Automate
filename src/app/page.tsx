'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageContainer, PageHeader, EmptyState } from '@/components/ui/page';
import { ButtonLink } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/components/ui/cn';
import { VIDEO_STEPS, currentStep, statusOf } from '@/components/shell/video-status';

interface VideoSummary {
  id: string;
  title: string | null;
  topic: string;
  style: string | null;
  target_minutes: number | null;
  status: string;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
}

type Filter = 'all' | 'review' | 'production' | 'done' | 'failed';

const FILTERS: Array<{ id: Filter; label: string; statuses?: string[] }> = [
  { id: 'all', label: 'All' },
  { id: 'review', label: 'To review', statuses: ['script_review'] },
  { id: 'production', label: 'In production', statuses: ['queued', 'scripting', 'voicing', 'sourcing', 'assembling'] },
  { id: 'done', label: 'Rendered', statuses: ['rendered', 'published'] },
  { id: 'failed', label: 'Failed', statuses: ['failed'] },
];

const inFilter = (v: VideoSummary, f: Filter) => {
  const statuses = FILTERS.find((x) => x.id === f)?.statuses;
  return !statuses || statuses.includes(v.status);
};

const prettyStyle = (s: string | null) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'No style');

/** A video's thumbnail when it has been rendered, or a quiet placeholder. */
function Thumb({ video }: { video: VideoSummary }) {
  const [failed, setFailed] = useState(false);
  const rendered = video.status === 'rendered' || video.status === 'published';
  return (
    <div className="relative aspect-video overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      {rendered && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/videos/${video.id}/publish/file?kind=thumbnail&n=1`}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
      ) : (
        <div className="grid h-full w-full place-items-center bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.12),transparent_60%)]">
          <Icon name="film" size={28} className="text-zinc-700" />
        </div>
      )}
    </div>
  );
}

/** The six steps as small marks: done, the one it's at, and the rest. */
function StepMarks({ status }: { status: string }) {
  const at = VIDEO_STEPS.findIndex((s) => s.key === currentStep(status));
  const done = status === 'rendered' || status === 'published';
  return (
    <div className="flex items-center gap-1" aria-label={`Step ${at + 1} of ${VIDEO_STEPS.length}`}>
      {VIDEO_STEPS.map((s, i) => (
        <span
          key={s.key}
          title={s.label}
          className={cn('h-1.5 flex-1 rounded-full', i < at || done ? 'bg-emerald-500/70' : i === at ? 'bg-indigo-400' : 'bg-zinc-800')}
        />
      ))}
    </div>
  );
}

function VideoCard({ video }: { video: VideoSummary }) {
  const st = statusOf(video.status);
  const step = VIDEO_STEPS.find((s) => s.key === currentStep(video.status)) ?? VIDEO_STEPS[0];
  return (
    <Link
      href={`/videos/${video.id}/${step.key}`}
      className="group flex min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-3 transition-colors hover:border-zinc-700 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70"
    >
      <Thumb video={video} />
      <div className="min-w-0 space-y-2 px-1 pb-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-zinc-100 group-hover:text-white">{video.title || video.topic}</h3>
          <Badge tone={st.tone} pulse={st.busy} className="shrink-0">
            {st.label}
          </Badge>
        </div>
        <p className="truncate text-xs text-zinc-500">
          {prettyStyle(video.style)}
          {video.target_minutes ? ` · ${video.target_minutes} min` : ''}
          {video.created_at ? ` · ${new Date(video.created_at).toLocaleDateString()}` : ''}
        </p>
        <StepMarks status={video.status} />
        <p className="flex items-center gap-1 text-xs font-medium text-zinc-400 group-hover:text-indigo-300">
          {video.status === 'failed' ? 'See what went wrong' : video.status === 'rendered' || video.status === 'published' ? 'Open Publish' : `Continue: ${step.label}`}
          <Icon name="chevronRight" size={14} className="transition-transform group-hover:translate-x-0.5" />
        </p>
      </div>
    </Link>
  );
}

/**
 * The studio's home: every video as a card (thumbnail, status, how far it has got), with a
 * search and filters by where each video stands.
 */
export default function VideosDashboard() {
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/videos?summary=1')
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load your videos.');
        const data = await res.json();
        if (!cancelled) setVideos(Array.isArray(data) ? data : []);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load your videos.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, videos.filter((v) => inFilter(v, f.id)).length])) as Record<Filter, number>, [videos]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return videos.filter((v) => inFilter(v, filter) && (!q || `${v.title ?? ''} ${v.topic} ${v.style ?? ''}`.toLowerCase().includes(q)));
  }, [videos, filter, query]);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Studio"
        title="Videos"
        description="Every video, from script to publish. Open one to pick up where it left off."
        actions={
          <ButtonLink href="/videos/new" variant="primary" icon="plus">
            New video
          </ButtonLink>
        }
      />

      {!loading && !error && videos.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(['review', 'production', 'done', 'failed'] as const).map((f) => {
            const item = FILTERS.find((x) => x.id === f)!;
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(filter === f ? 'all' : f)}
                aria-pressed={filter === f}
                className={cn(
                  'rounded-2xl border p-4 text-left transition-colors',
                  filter === f ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-zinc-800/80 bg-zinc-900/50 hover:border-zinc-700',
                )}
              >
                <p className="text-xs text-zinc-400">{item.label}</p>
                <p className={cn('mt-1 text-2xl font-semibold tabular-nums', f === 'failed' && counts[f] ? 'text-red-300' : 'text-zinc-50')}>{counts[f]}</p>
              </button>
            );
          })}
        </div>
      )}

      {!loading && !error && videos.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                className={cn(
                  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors',
                  filter === f.id ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100',
                )}
              >
                {f.label}
                <span className="text-zinc-500 tabular-nums">{counts[f.id]}</span>
              </button>
            ))}
          </div>
          <label className="relative block sm:w-72">
            <span className="sr-only">Search videos</span>
            <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, topic or style"
              className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-900/60 pl-9 pr-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600 focus:outline-none"
            />
          </label>
        </div>
      )}

      {loading ? (
        <EmptyState loading title="Loading your videos…" />
      ) : error ? (
        <EmptyState title={error} description="Check that the Supabase settings in .env.local are filled in." />
      ) : videos.length === 0 ? (
        <EmptyState
          title="Make your first video"
          description="Start from an idea, a pasted script or subtitles. The studio writes, voices, illustrates and assembles it."
          action={
            <ButtonLink href="/videos/new" variant="primary" icon="plus">
              New video
            </ButtonLink>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState title="No videos match" description="Try another filter or search." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((v) => (
            <VideoCard key={v.id} video={v} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
