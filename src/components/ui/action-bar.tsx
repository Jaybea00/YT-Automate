import React from 'react';

/**
 * The bar along the bottom of a step: what the step is waiting for, and its one main action,
 * always in reach however far down the page you are. It sits at the end of the page and sticks
 * to the bottom of the screen while you scroll.
 */
export function ActionBar({ hint, children }: { hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-30 -mx-4 sm:-mx-6 lg:-mx-8 border-t border-zinc-800/80 bg-zinc-950/90 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/75">
      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        {hint ? <p className="min-w-0 text-xs text-zinc-400 leading-relaxed">{hint}</p> : <span />}
        <div className="flex flex-wrap items-center gap-2 sm:justify-end [&>*]:flex-1 sm:[&>*]:flex-none">{children}</div>
      </div>
    </div>
  );
}
