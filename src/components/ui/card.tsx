import React from 'react';
import { cn } from './cn';

/**
 * A card: the one surface style for panels. With a title it gets a header row (title,
 * optional description, actions on the right that wrap under the title on a phone).
 */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  padded = true,
  id,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  padded?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={cn('min-w-0 rounded-2xl border border-zinc-800/80 bg-zinc-900/60', padded && 'p-4 sm:p-6', className)}>
      {(title || actions) && (
        <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2', children ? 'mb-4' : '')}>
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-zinc-50 tracking-tight">{title}</h2>}
            {description && <p className="mt-1 text-sm text-zinc-400 leading-relaxed">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A quiet inner panel inside a card (settings groups, results). */
export function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3 sm:p-4', className)}>{children}</div>;
}
