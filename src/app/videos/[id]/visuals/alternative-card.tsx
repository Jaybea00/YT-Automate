'use client';

import React, { useState } from 'react';

const LICENSES: Record<string, string> = {
  public_domain: 'Public domain',
  cc0: 'CC0',
  cc_by: 'CC BY',
  cc_by_sa: 'CC BY-SA',
  pixabay: 'Pixabay licence',
  pexels: 'Pexels licence',
  unsplash: 'Unsplash licence',
  nasa: 'NASA (public)',
  own_work: 'Your own',
};

/**
 * One footage candidate: its thumbnail, playing on hover when it's a video (loaded only then),
 * with the relevance score when it was checked, where it comes from, its licence and a link to
 * its source page.
 */
export function AlternativeCard({
  thumbnailUrl,
  title,
  provider,
  isVideo,
  videoUrl,
  pageUrl,
  license,
  score,
  durationSec,
  current,
  disabled,
  onPick,
  pickLabel,
}: {
  thumbnailUrl?: string;
  title?: string;
  provider: string;
  isVideo: boolean;
  videoUrl?: string;
  pageUrl?: string;
  license?: string;
  score?: number;
  durationSec?: number;
  current?: boolean;
  disabled?: boolean;
  onPick: () => void;
  pickLabel?: string;
}) {
  const [hover, setHover] = useState(false);
  const licence = license ? LICENSES[license] ?? license.replace(/_/g, ' ') : null;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`group relative rounded-lg overflow-hidden border bg-zinc-950 flex flex-col ${
        current ? 'border-emerald-500 ring-2 ring-emerald-500/30' : 'border-zinc-800 hover:border-indigo-500/70'
      }`}
    >
      <button type="button" onClick={onPick} disabled={disabled || current} title={title} className="relative aspect-video w-full bg-black disabled:cursor-default">
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnailUrl} alt={title ?? 'Candidate'} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <span className="text-zinc-600 text-[10px]">No preview</span>
        )}
        {isVideo && hover && videoUrl && (
          <video src={videoUrl} muted loop autoPlay playsInline preload="auto" className="absolute inset-0 w-full h-full object-cover" />
        )}
        <span className="absolute bottom-0.5 left-0.5 px-1 rounded text-[9px] bg-black/80 text-zinc-300">
          {provider}
          {isVideo ? ` ▶${durationSec ? ` ${Math.round(durationSec)}s` : ''}` : ' ◻ photo'}
        </span>
        {score !== undefined && (
          <span
            title="How well it matches the narration (checked by the vision model)"
            className={`absolute top-0.5 right-0.5 px-1 rounded text-[9px] font-bold bg-black/80 ${
              score >= 7 ? 'text-emerald-300' : score >= 5 ? 'text-amber-300' : 'text-red-300'
            }`}
          >
            {score}/10
          </span>
        )}
        {current && <span className="absolute top-0.5 left-0.5 px-1 rounded text-[9px] font-bold bg-emerald-600 text-white">In use</span>}
      </button>
      <div className="px-1.5 py-1 space-y-0.5">
        <p className="text-[10px] text-zinc-300 truncate" title={title}>
          {title || 'Untitled'}
        </p>
        <div className="flex items-center justify-between gap-1 text-[9px] text-zinc-500">
          <span className="truncate">{licence ?? ''}</span>
          {pageUrl && (
            <a href={pageUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-indigo-400 hover:text-indigo-300 shrink-0">
              source ↗
            </a>
          )}
        </div>
        {pickLabel && !current && (
          <button
            type="button"
            onClick={onPick}
            disabled={disabled}
            className="w-full py-0.5 rounded text-[10px] font-bold bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
          >
            {pickLabel}
          </button>
        )}
      </div>
    </div>
  );
}
