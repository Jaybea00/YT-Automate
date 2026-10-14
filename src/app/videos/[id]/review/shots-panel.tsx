'use client';

import React from 'react';
import type { ScriptBeat, ShotPlan, ShotType } from '@/lib/script/generate-script';
import { SPEECH_WORDS_PER_SECOND } from '@/lib/script/script-quality';

const SHOT_STYLE: Record<ShotType, { label: string; icon: string; bar: string; chip: string }> = {
  stock: { label: 'Stock', icon: '🎬', bar: 'bg-zinc-600', chip: 'text-zinc-300 border-zinc-700 bg-zinc-800/60' },
  archive: { label: 'Archive', icon: '🏛️', bar: 'bg-orange-500/70', chip: 'text-orange-300 border-orange-500/30 bg-orange-500/10' },
  chart: { label: 'Chart', icon: '📊', bar: 'bg-emerald-500/80', chip: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' },
  stat: { label: 'Stat', icon: '🔢', bar: 'bg-teal-400/80', chip: 'text-teal-300 border-teal-500/30 bg-teal-500/10' },
  quote: { label: 'Quote', icon: '❝', bar: 'bg-fuchsia-500/70', chip: 'text-fuchsia-300 border-fuchsia-500/30 bg-fuchsia-500/10' },
  geo_map: { label: 'Map', icon: '🗺️', bar: 'bg-blue-500/80', chip: 'text-blue-300 border-blue-500/30 bg-blue-500/10' },
  newspaper: { label: 'Newspaper', icon: '📰', bar: 'bg-amber-500/80', chip: 'text-amber-300 border-amber-500/30 bg-amber-500/10' },
  screen_recording: { label: 'Screen', icon: '💻', bar: 'bg-indigo-500/80', chip: 'text-indigo-300 border-indigo-500/30 bg-indigo-500/10' },
  timeline: { label: 'Timeline', icon: '🕰️', bar: 'bg-cyan-500/80', chip: 'text-cyan-300 border-cyan-500/30 bg-cyan-500/10' },
  comparison: { label: 'Compare', icon: '⚖️', bar: 'bg-lime-500/80', chip: 'text-lime-300 border-lime-500/30 bg-lime-500/10' },
  title: { label: 'Title', icon: '🔖', bar: 'bg-rose-500/80', chip: 'text-rose-300 border-rose-500/30 bg-rose-500/10' },
  kinetic_text: { label: 'Kinetic', icon: '🔤', bar: 'bg-violet-500/80', chip: 'text-violet-300 border-violet-500/30 bg-violet-500/10' },
};

const shotSeconds = (shot: ShotPlan) => shot.word_count / SPEECH_WORDS_PER_SECOND;

function describeSpec(shot: ShotPlan): string {
  if (shot.chart) {
    const points = shot.chart.labels.map((l, i) => `${l}: ${shot.chart!.values[i]}`).join(', ');
    return `${shot.chart.chart_type} chart "${shot.chart.title}"${shot.chart.unit ? ` (${shot.chart.unit})` : ''}: ${points}`;
  }
  if (shot.stat) return `${shot.stat.prefix ?? ''}${shot.stat.value}${shot.stat.suffix ?? ''} ${shot.stat.label}`;
  if (shot.quote) return `"${shot.quote.text}" (${shot.quote.attribution})`;
  if (shot.map) return `${shot.map.mode}: ${shot.map.places.join(' → ')}`;
  if (shot.newspaper) return `${shot.newspaper.outlet}, ${shot.newspaper.date}: "${shot.newspaper.headline}"`;
  if (shot.timeline) return shot.timeline.events.map((e) => `${e.date}: ${e.label}`).join(' → ');
  if (shot.comparison) {
    const { left, right } = shot.comparison;
    return `${left.value} ${left.label} vs ${right.value} ${right.label}`;
  }
  if (shot.title_card) return `${shot.title_card.kicker ? `${shot.title_card.kicker} · ` : ''}${shot.title_card.text}`;
  if (shot.kinetic) return `"${shot.kinetic.phrase}"`;
  if (shot.caption) return `${shot.visual_query} · caption: ${shot.caption.name}${shot.caption.detail ? `, ${shot.caption.detail}` : ''}`;
  return shot.visual_query;
}

/** Shot timeline for one beat: a proportional strip, then each shot's words and plan. */
export function BeatShots({ beat }: { beat: ScriptBeat }) {
  if (!beat.shots?.length) {
    return <div className="text-[11px] text-zinc-500 italic">No shot plan yet for this beat.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-900 gap-0.5" aria-hidden>
        {beat.shots.map((shot, i) => (
          <div
            key={i}
            className={SHOT_STYLE[shot.visual_type].bar}
            style={{ flexGrow: shot.word_count }}
            title={`${SHOT_STYLE[shot.visual_type].label} · ${shotSeconds(shot).toFixed(1)}s`}
          />
        ))}
      </div>
      <ol className="space-y-1.5">
        {beat.shots.map((shot, i) => {
          const style = SHOT_STYLE[shot.visual_type];
          return (
            <li key={i} className="flex gap-2 text-[11px] leading-relaxed">
              <span className={`shrink-0 h-fit px-1.5 py-0.5 rounded-md border font-medium ${style.chip}`}>
                {style.icon} {style.label} · {shotSeconds(shot).toFixed(1)}s
              </span>
              <span className="text-zinc-400">
                <span className="text-zinc-200">&ldquo;{shot.covers}&rdquo;</span>
                <span className="block text-zinc-500 font-mono">{describeSpec(shot)}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Summary of the whole shot plan with planning actions. */
export function ShotPlanSummary({
  beats,
  isPlanning,
  hasUnsavedEdits,
  onPlanMissing,
  onReplanAll,
}: {
  beats: ScriptBeat[];
  isPlanning: boolean;
  hasUnsavedEdits: boolean;
  onPlanMissing: () => void;
  onReplanAll: () => void;
}) {
  const shots = beats.flatMap((b) => b.shots ?? []);
  const missing = beats.filter((b) => !b.shots?.length).length;
  const avg = shots.length ? shots.reduce((s, shot) => s + shotSeconds(shot), 0) / shots.length : 0;
  const counts = shots.reduce<Partial<Record<ShotType, number>>>((acc, s) => {
    acc[s.visual_type] = (acc[s.visual_type] ?? 0) + 1;
    return acc;
  }, {});

  const button =
    'px-3 py-1.5 rounded-lg text-xs font-semibold border transition disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed';

  return (
    <div className="rounded-xl bg-zinc-950/60 border border-zinc-800 p-3.5 text-xs space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-zinc-200 font-semibold">
          🎬 Shot plan
          <span className="font-normal text-zinc-400">
            {shots.length
              ? ` · ${shots.length} shots · picture changes every ~${avg.toFixed(1)}s`
              : ' · not planned yet'}
            {missing > 0 && shots.length > 0 ? ` · ${missing} beat${missing === 1 ? '' : 's'} need planning` : ''}
          </span>
        </span>
        <span className="flex gap-2">
          {missing > 0 && (
            <button
              type="button"
              onClick={onPlanMissing}
              disabled={isPlanning || hasUnsavedEdits}
              className={`${button} bg-indigo-950/60 hover:bg-indigo-900/80 text-indigo-300 border-indigo-800`}
            >
              {isPlanning ? 'Planning shots...' : `Plan ${missing === beats.length ? 'shots' : `${missing} beat${missing === 1 ? '' : 's'}`}`}
            </button>
          )}
          {shots.length > 0 && (
            <button
              type="button"
              onClick={onReplanAll}
              disabled={isPlanning || hasUnsavedEdits}
              className={`${button} bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-zinc-700`}
            >
              Re-plan all
            </button>
          )}
        </span>
      </div>
      {shots.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(counts) as ShotType[]).map((type) => (
            <span key={type} className={`px-2 py-0.5 rounded-md border ${SHOT_STYLE[type].chip}`}>
              {SHOT_STYLE[type].icon} {SHOT_STYLE[type].label} {counts[type]}
            </span>
          ))}
        </div>
      )}
      {hasUnsavedEdits && missing > 0 && (
        <p className="text-zinc-500">Save your beat edits before planning shots.</p>
      )}
      {isPlanning && <p className="text-zinc-500">The director is planning shots; this can take a few minutes.</p>}
    </div>
  );
}
