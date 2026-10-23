'use client';

import React from 'react';
import { chosenPackage, type Packaging } from '@/lib/script/packaging-types';

const inputClass =
  'w-full px-2 py-1 bg-zinc-950 border border-zinc-800 rounded-md text-zinc-100 focus:outline-none focus:border-indigo-500';

/** Brief mode: pick (and tweak) the title and thumbnail the script will be written to deliver. */
export function PackagingPicker({ packaging, onChange }: { packaging: Packaging; onChange: (next: Packaging) => void }) {
  const edit = (i: number, patch: Partial<Packaging['options'][number]>) =>
    onChange({ ...packaging, options: packaging.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });

  return (
    <div className="space-y-2">
      <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider">
        Packaging: the title and thumbnail the script will deliver
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {packaging.options.map((o, i) => {
          const selected = packaging.chosen === i;
          return (
            <div
              key={i}
              onClick={() => onChange({ ...packaging, chosen: i })}
              className={`p-3 rounded-xl border cursor-pointer space-y-1.5 text-xs ${
                selected ? 'bg-red-950/20 border-red-500/60' : 'bg-zinc-950/60 border-zinc-800 hover:border-zinc-700'
              }`}
            >
              <div className="flex items-center gap-2">
                <input type="radio" checked={selected} onChange={() => onChange({ ...packaging, chosen: i })} className="accent-red-500" />
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">{o.angle}</span>
              </div>
              {selected ? (
                <>
                  <input value={o.title} onChange={(e) => edit(i, { title: e.target.value })} className={`${inputClass} font-semibold`} />
                  <input
                    value={o.thumbnail_text}
                    onChange={(e) => edit(i, { thumbnail_text: e.target.value })}
                    placeholder="Thumbnail text (2-4 words)"
                    className={inputClass}
                  />
                </>
              ) : (
                <p className="text-zinc-100 font-semibold">{o.title}</p>
              )}
              <p className="text-zinc-400">
                🖼 {o.thumbnail_image}
                {!selected && o.thumbnail_text ? ` · “${o.thumbnail_text}”` : ''}
              </p>
              <p className="text-zinc-500 italic">{o.promise}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** After the script: the promise it was written to keep, to check it pays off. */
export function PackagingSummary({ packaging }: { packaging: Packaging | undefined }) {
  const pkg = chosenPackage(packaging);
  if (!pkg) return null;
  return (
    <div className="rounded-xl bg-zinc-950/60 border border-zinc-800 text-xs p-3.5 space-y-1">
      <p className="text-zinc-200 font-semibold">
        📦 Written to deliver: <span className="text-white">{pkg.title}</span>
      </p>
      <p className="text-zinc-400">
        Thumbnail: {pkg.thumbnail_image}
        {pkg.thumbnail_text ? ` · “${pkg.thumbnail_text}”` : ''}
      </p>
      <p className="text-zinc-500 italic">Promise: {pkg.promise}</p>
    </div>
  );
}
