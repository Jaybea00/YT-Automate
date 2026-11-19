import React from 'react';
import { cn } from './cn';

/**
 * Page layout: one content width for the app (wide for workspaces, narrow for forms), the same
 * side padding everywhere, and a header with title, description and actions that stack on a phone.
 */
export function PageContainer({ children, width = 'wide', className }: { children: React.ReactNode; width?: 'narrow' | 'wide' | 'full'; className?: string }) {
  const max = width === 'narrow' ? 'max-w-3xl' : width === 'full' ? 'max-w-[1600px]' : 'max-w-6xl';
  return <div className={cn('mx-auto w-full px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6', max, className)}>{children}</div>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Small facts under the title (badges, counts). */
  meta?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        {eyebrow && <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{eyebrow}</p>}
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-zinc-50 break-words">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-zinc-400 leading-relaxed">{description}</p>}
        {meta && <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-zinc-400">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
    </header>
  );
}

/** An empty or loading state: centred, calm, with an optional action. */
export function EmptyState({ title, description, action, loading }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; loading?: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30 px-6 py-12 text-center space-y-3">
      {loading && <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-zinc-700 border-t-indigo-400" />}
      <p className="text-sm font-semibold text-zinc-200">{title}</p>
      {description && <p className="mx-auto max-w-md text-xs text-zinc-400 leading-relaxed">{description}</p>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}
