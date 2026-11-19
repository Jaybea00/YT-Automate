'use client';

import React from 'react';

/**
 * The render page's working log: each pipeline stage with its state, and every unit of work
 * (a beat voiced, a visual sourced) with its timing, cost, output and licence.
 */

export interface JobData {
  id: string;
  status: 'queued' | 'running' | 'failed' | 'done' | 'cancelled';
  stages: string[];
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StageData {
  id: string;
  stage: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface UnitData {
  id: string;
  stage: string;
  unit_index: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  duration_ms: number | null;
  cost_usd: number | null;
  attempts: number;
  error: string | null;
  output_path: string | null;
}

export interface VideoAssetData {
  id: string;
  video_id: string;
  beat_index: number;
  visual_type: 'chart' | 'screen_recording' | 'stock' | string;
  source_url: string | null;
  license_type: string | null;
  license_source: string | null;
  attribution_text: string | null;
  license_proof_url: string | null;
  created_at?: string;
}

export type StageFilter = 'all' | 'visuals' | 'tts';

export function PipelineLog({
  job,
  stages,
  units,
  assets,
  filteredUnits,
  stageFilter,
  setStageFilter,
  completedUnits,
  totalUnits,
  totalCost,
  ttsUnitsCount,
  visualsUnitsCount,
}: {
  job: JobData | null | undefined;
  stages: StageData[];
  units: UnitData[];
  assets: VideoAssetData[];
  filteredUnits: UnitData[];
  stageFilter: StageFilter;
  setStageFilter: (f: StageFilter) => void;
  completedUnits: number;
  totalUnits: number;
  totalCost: number;
  ttsUnitsCount: number;
  visualsUnitsCount: number;
}) {
  return (
    <>
      {/* Pipeline Stages Progress */}
      {job && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-8 space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Pipeline Stages</h2>
            <span className="text-xs text-zinc-400 font-mono">Job ID: {job.id}</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {(job.stages && job.stages.length > 0
              ? job.stages
              : ['research', 'script', 'tts', 'assembly']
            ).map((stageName) => {
              const stageRow = stages.find((s) => s.stage === stageName);
              const stageStatus = stageRow?.status || 'pending';

              return (
                <div
                  key={stageName}
                  className={`p-4 rounded-xl border flex flex-col justify-between gap-3 ${
                    stageStatus === 'done'
                      ? 'bg-emerald-950/20 border-emerald-800/60'
                      : stageStatus === 'running'
                      ? 'bg-blue-950/20 border-blue-600'
                      : stageStatus === 'failed'
                      ? 'bg-rose-950/20 border-rose-800'
                      : 'bg-zinc-950 border-zinc-800 opacity-70'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm capitalize text-zinc-200">
                      {stageName}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-mono ${
                        stageStatus === 'done'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : stageStatus === 'running'
                          ? 'bg-blue-500/10 text-blue-400 animate-pulse'
                          : stageStatus === 'failed'
                          ? 'bg-rose-500/10 text-rose-400'
                          : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {stageStatus}
                    </span>
                  </div>

                  {stageRow?.error && (
                    <p className="text-xs text-rose-400 line-clamp-2">
                      {stageRow.error}
                    </p>
                  )}

                  {stageRow?.started_at && (
                    <span className="text-[11px] text-zinc-500">
                      Started: {new Date(stageRow.started_at).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Scene Units Fine-Grained Checkpoints */}
      {units.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-white">Scene Checkpoints</h2>
              <p className="text-xs text-zinc-400">
                Completed {completedUnits} of {totalUnits} unit tasks
                {totalCost > 0 && ` • Estimated Cost: $${totalCost.toFixed(4)}`}
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              {/* Filter Tabs */}
              <div className="flex items-center gap-1.5 bg-zinc-950 p-1 rounded-xl border border-zinc-800 text-xs">
                <button
                  onClick={() => setStageFilter('all')}
                  className={`px-3 py-1.5 rounded-lg font-medium transition ${
                    stageFilter === 'all'
                      ? 'bg-zinc-800 text-white shadow'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  All ({totalUnits})
                </button>
                {visualsUnitsCount > 0 && (
                  <button
                    onClick={() => setStageFilter('visuals')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 ${
                      stageFilter === 'visuals'
                        ? 'bg-emerald-600 text-white shadow'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <span>Visuals</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-950/80 border border-emerald-500/30">
                      {visualsUnitsCount}
                    </span>
                  </button>
                )}
                {ttsUnitsCount > 0 && (
                  <button
                    onClick={() => setStageFilter('tts')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 ${
                      stageFilter === 'tts'
                        ? 'bg-blue-600 text-white shadow'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <span>TTS</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-blue-950/80 border border-blue-500/30">
                      {ttsUnitsCount}
                    </span>
                  </button>
                )}
              </div>

              <div className="w-full sm:w-36 bg-zinc-800 h-2.5 rounded-full overflow-hidden shrink-0">
                <div
                  className="bg-emerald-500 h-full transition-all duration-500"
                  style={{
                    width: `${totalUnits > 0 ? (completedUnits / totalUnits) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            {filteredUnits.map((unit) => {
              const asset =
                unit.stage === 'visuals'
                  ? assets.find((a) => a.beat_index === unit.unit_index)
                  : null;
              const visualType =
                asset?.visual_type ||
                (unit.output_path?.endsWith('.png') ? 'chart' : 'stock');

              if (unit.stage === 'visuals') {
                return (
                  <div
                    key={unit.id}
                    className="p-5 rounded-xl bg-zinc-950 border border-zinc-800/90 hover:border-zinc-700/80 transition space-y-4"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-700 flex items-center justify-center text-xs font-mono font-bold text-zinc-300 shrink-0">
                          #{unit.unit_index}
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                              {unit.stage}
                            </span>
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                                unit.status === 'done'
                                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                  : unit.status === 'running'
                                  ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse'
                                  : unit.status === 'failed'
                                  ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                                  : 'bg-zinc-800 text-zinc-400'
                              }`}
                            >
                              {unit.status}
                            </span>
                          </div>
                          {unit.output_path && (
                            <p
                              className="text-xs text-zinc-500 font-mono truncate max-w-xs sm:max-w-md mt-0.5"
                              title={unit.output_path}
                            >
                              {unit.output_path}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 text-xs text-zinc-400 font-mono self-end sm:self-center">
                        {unit.duration_ms != null && unit.duration_ms > 0 && (
                          <span className="bg-zinc-900 px-2.5 py-1 rounded border border-zinc-800 text-zinc-300">
                            {(unit.duration_ms / 1000).toFixed(1)}s
                          </span>
                        )}
                        {unit.cost_usd != null && (
                          <span>${Number(unit.cost_usd).toFixed(4)}</span>
                        )}
                        {unit.attempts > 1 && (
                          <span className="text-amber-400">{unit.attempts} attempts</span>
                        )}
                      </div>
                    </div>

                    {job && unit.status === 'done' && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start pt-2 border-t border-zinc-900">
                        {/* Visual Media Preview */}
                        <div className="space-y-2">
                          {visualType === 'chart' ? (
                            <div className="rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900 flex items-center justify-center aspect-video">
                              <img
                                src={`/api/jobs/${job.id}/units/${unit.unit_index}/visual`}
                                alt={`Beat ${unit.unit_index} chart`}
                                className="w-full h-full object-contain"
                                loading="lazy"
                              />
                            </div>
                          ) : (
                            <div className="rounded-xl overflow-hidden border border-zinc-800 bg-black aspect-video flex items-center justify-center">
                              <video
                                controls
                                preload="metadata"
                                className="w-full h-full object-contain"
                                src={`/api/jobs/${job.id}/units/${unit.unit_index}/visual`}
                              />
                            </div>
                          )}
                        </div>

                        {/* Provenance Fields */}
                        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                              Provenance & License
                            </span>
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              {asset?.visual_type || visualType}
                            </span>
                          </div>

                          {asset ? (
                            <div className="space-y-2.5 text-xs text-zinc-300">
                              {asset.license_source && (
                                <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 pb-2">
                                  <span className="text-zinc-400 text-xs">Source Provider:</span>
                                  <span className="font-medium text-white capitalize bg-zinc-800 px-2 py-0.5 rounded border border-zinc-700/60 font-mono text-[11px]">
                                    {asset.license_source}
                                  </span>
                                </div>
                              )}

                              {asset.source_url && (
                                <div className="space-y-1 border-b border-zinc-800/60 pb-2">
                                  <span className="text-zinc-400 text-xs">Original Media URL:</span>
                                  <div>
                                    <a
                                      href={asset.source_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-sky-400 hover:text-sky-300 hover:underline inline-flex items-center gap-1.5 break-all text-[11px] font-mono"
                                      title={asset.source_url}
                                    >
                                      <span className="line-clamp-1">{asset.source_url}</span>
                                      <span className="shrink-0 text-xs">↗</span>
                                    </a>
                                  </div>
                                </div>
                              )}

                              {asset.license_type && (
                                <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 pb-2">
                                  <span className="text-zinc-400 text-xs">License:</span>
                                  <span className="text-zinc-200 text-[11px]">
                                    {asset.license_type}
                                  </span>
                                </div>
                              )}

                              {asset.attribution_text && (
                                <div className="space-y-1">
                                  <span className="text-zinc-400 text-xs">Attribution:</span>
                                  <p
                                    className="text-[11px] text-zinc-300 bg-zinc-950/70 p-2.5 rounded-lg border border-zinc-800/80 font-mono break-words"
                                    title={asset.attribution_text}
                                  >
                                    {asset.attribution_text}
                                  </p>
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-xs text-zinc-500 italic py-2">
                              No provenance record registered in video_assets.
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div
                  key={unit.id}
                  className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-700 flex items-center justify-center text-xs font-mono font-bold text-zinc-300 shrink-0">
                      #{unit.unit_index}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold uppercase text-zinc-300">
                          {unit.stage}
                        </span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                            unit.status === 'done'
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : unit.status === 'running'
                              ? 'bg-blue-500/10 text-blue-400 animate-pulse'
                              : unit.status === 'failed'
                              ? 'bg-rose-500/10 text-rose-400'
                              : 'bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {unit.status}
                        </span>
                      </div>
                      {unit.output_path && (
                        <p className="text-xs text-zinc-500 font-mono truncate max-w-xs sm:max-w-md mt-0.5">
                          {unit.output_path}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-4 self-end md:self-center">
                    {job && unit.status === 'done' && unit.stage === 'tts' && (
                      <audio
                        controls
                        preload="none"
                        className="h-8 max-w-[240px] sm:max-w-[280px]"
                        src={`/api/jobs/${job.id}/units/${unit.unit_index}/audio`}
                      />
                    )}

                    <div className="flex items-center gap-4 text-xs text-zinc-400 font-mono">
                      {unit.duration_ms != null && unit.duration_ms > 0 && (
                        <span>{(unit.duration_ms / 1000).toFixed(1)}s</span>
                      )}
                      {unit.cost_usd != null && (
                        <span>${Number(unit.cost_usd).toFixed(4)}</span>
                      )}
                      {unit.attempts > 1 && (
                        <span className="text-amber-400">{unit.attempts} attempts</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
