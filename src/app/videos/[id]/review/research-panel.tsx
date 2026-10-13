'use client';

import React, { useState } from 'react';
import type { ScriptBeat } from '@/lib/script/generate-script';
import type { ResearchDossier } from '@/lib/research/types';

const PROVIDER_LABEL: Record<ResearchDossier['provider'], string> = {
  wikipedia: 'Wikipedia',
  google_search: 'Google Search',
};

/** Summary of the research behind the script, with an expandable list of sources and facts. */
export function ResearchPanel({
  research,
  beats,
}: {
  research: ResearchDossier | undefined;
  beats: ScriptBeat[];
}) {
  const [open, setOpen] = useState(false);

  if (!research) {
    return (
      <div className="p-3.5 rounded-xl bg-amber-950/30 border border-amber-800/60 text-amber-200 text-xs">
        No research dossier for this script, so its numbers, dates, and quotes haven&apos;t been checked against
        sources. Double-check them before approving.
      </div>
    );
  }

  const usedFacts = new Set(beats.flatMap((b) => b.fact_ids ?? []));
  const flagged = beats.filter((b) => b.needs_check).length;

  return (
    <div className="rounded-xl bg-zinc-950/60 border border-zinc-800 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex flex-wrap items-center justify-between gap-2 p-3.5 text-left cursor-pointer"
      >
        <span className="text-zinc-200 font-semibold">
          📚 Researched from {research.sources.length} {PROVIDER_LABEL[research.provider]} source
          {research.sources.length === 1 ? '' : 's'}
          <span className="font-normal text-zinc-400">
            {' '}
            · {usedFacts.size} of {research.facts.length} facts used
          </span>
        </span>
        <span className="flex items-center gap-3">
          {flagged > 0 ? (
            <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 font-medium">
              ⚠ {flagged} beat{flagged === 1 ? '' : 's'} need{flagged === 1 ? 's' : ''} checking
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-medium">
              ✓ All specifics sourced
            </span>
          )}
          <span className="text-zinc-500">{open ? 'Hide' : 'Show'} sources</span>
        </span>
      </button>

      {open && (
        <div className="border-t border-zinc-800 p-3.5 space-y-3">
          <ul className="space-y-1">
            {research.sources.map((s) => (
              <li key={s.id}>
                <span className="font-mono text-zinc-500 mr-2">{s.id}</span>
                <a href={s.url} target="_blank" rel="noreferrer" className="text-indigo-300 hover:text-indigo-200 underline">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
          <ol className="space-y-1 max-h-72 overflow-y-auto pr-1">
            {research.facts.map((f) => (
              <li key={f.id} className={usedFacts.has(f.id) ? 'text-zinc-200' : 'text-zinc-500'}>
                <span className="font-mono text-zinc-500 mr-2">{f.id}</span>
                {f.claim}
                <span className="font-mono text-zinc-600 ml-1">[{f.sourceIds.join(', ')}]</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/** Per-beat source chips and the "needs check" warning. */
export function BeatSources({
  beat,
  research,
  onMarkChecked,
}: {
  beat: ScriptBeat;
  research: ResearchDossier | undefined;
  onMarkChecked: () => void;
}) {
  if (!research) return null;
  const facts = (beat.fact_ids ?? [])
    .map((id) => research.facts.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));

  if (facts.length === 0 && !beat.needs_check) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {facts.map((fact) => {
        const source = research.sources.find((s) => s.id === fact.sourceIds[0]);
        return (
          <a
            key={fact.id}
            href={source?.url}
            target="_blank"
            rel="noreferrer"
            title={`${fact.claim}${source ? ` (${source.title})` : ''}`}
            className="px-2 py-0.5 rounded-md bg-indigo-950/50 border border-indigo-800/60 text-indigo-300 hover:text-indigo-200 font-mono"
          >
            {fact.id}
          </a>
        );
      })}
      {beat.needs_check && (
        <>
          <span className="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300">
            ⚠ Needs check: numbers or quotes with no researched source
          </span>
          <button
            type="button"
            onClick={onMarkChecked}
            className="px-2 py-0.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 cursor-pointer"
          >
            Mark checked
          </button>
        </>
      )}
    </div>
  );
}
