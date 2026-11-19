import React from 'react';
import { cn } from './cn';

/** Status badges: one shape, colour by meaning. */
export type BadgeTone = 'neutral' | 'info' | 'accent' | 'success' | 'warning' | 'danger';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  info: 'bg-sky-500/10 text-sky-300 border-sky-500/25',
  accent: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/25',
  success: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
  warning: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
  danger: 'bg-red-500/10 text-red-300 border-red-500/25',
};

export function Badge({ tone = 'neutral', children, className, pulse }: { tone?: BadgeTone; children: React.ReactNode; className?: string; pulse?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap', TONE[tone], className)}>
      {pulse && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />}
      {children}
    </span>
  );
}
