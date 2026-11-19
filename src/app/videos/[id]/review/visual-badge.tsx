import React from 'react';
import type { ScriptBeat } from '@/lib/script/generate-script';

/** What kind of picture a beat plans, as a small coloured badge. */
export function VisualBadge({ type }: { type: ScriptBeat['visual_type'] }) {
  switch (type) {
    case 'newspaper':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 border border-amber-500/20 text-amber-400">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          📰 Newspaper
        </span>
      );
    case 'geo_map':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 border border-blue-500/20 text-blue-400">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
          🗺️ Map
        </span>
      );
    case 'archive':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-500/10 border border-orange-500/20 text-orange-400">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />
          🏛️ Archive
        </span>
      );
    case 'chart':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          📊 Chart
        </span>
      );
    case 'screen_recording':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
          💻 Screen
        </span>
      );
    case 'stock':
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 border border-purple-500/20 text-purple-400">
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
          🎬 Stock
        </span>
      );
  }
}
