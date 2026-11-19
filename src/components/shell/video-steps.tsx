'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { Icon, type IconName } from '@/components/ui/icon';
import { Badge } from '@/components/ui/badge';
import { VIDEO_STEPS, currentStep, statusOf } from './video-status';

/**
 * The bar at the top of every page of a video: its title and status, and its steps (Script,
 * Visuals, Storyboard, Vibedit, Render, Publish) as tabs. The page you're on is highlighted and
 * the step the video has reached is marked; on a phone the steps scroll sideways.
 */
export function VideoSteps({ videoId, title, status }: { videoId: string; title: string; status: string | null }) {
  const pathname = usePathname() ?? '';
  const here = VIDEO_STEPS.find((s) => pathname.startsWith(`/videos/${videoId}/${s.key}`))?.key;
  const reached = currentStep(status);
  const reachedIndex = VIDEO_STEPS.findIndex((s) => s.key === reached);
  const st = statusOf(status);

  return (
    <div className="border-b border-zinc-800/80 bg-zinc-950">
      <div className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-2 pt-3 text-xs text-zinc-500">
          <Link href="/" className="inline-flex items-center gap-1 hover:text-zinc-200">
            <Icon name="chevronLeft" size={14} />
            Videos
          </Link>
          <span className="text-zinc-700">/</span>
          <span className="truncate font-medium text-zinc-200" title={title}>
            {title}
          </span>
          <Badge tone={st.tone} pulse={st.busy} className="ml-1 shrink-0">
            {st.label}
          </Badge>
        </div>
        <nav aria-label="Video steps" className="-mx-1 mt-2 flex gap-1 overflow-x-auto pb-px [scrollbar-width:none]">
          {VIDEO_STEPS.map((s, i) => {
            const active = s.key === here;
            const done = i < reachedIndex;
            return (
              <Link
                key={s.key}
                href={`/videos/${videoId}/${s.key}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative inline-flex h-10 shrink-0 items-center gap-1.5 px-3 text-[13px] font-medium transition-colors',
                  active ? 'text-zinc-50' : 'text-zinc-400 hover:text-zinc-100',
                )}
              >
                <span
                  className={cn(
                    'grid h-5 w-5 place-items-center rounded-full border text-[10px]',
                    done ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : s.key === reached ? 'border-indigo-400/60 bg-indigo-500/15 text-indigo-200' : 'border-zinc-700 text-zinc-500',
                  )}
                >
                  {done ? <Icon name="check" size={11} strokeWidth={2.6} /> : <Icon name={s.icon as IconName} size={11} strokeWidth={2.2} />}
                </span>
                {s.label}
                {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-indigo-400" />}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
