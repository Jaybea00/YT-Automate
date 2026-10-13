'use client';

import React, { useEffect, useState } from 'react';
import type { ScriptBeat } from '@/lib/script/generate-script';
import type { BeatVariant, HookOption, ScriptReview } from '@/lib/script/script-editor';
import { scriptTextSignature, estimateSpeechSeconds } from '@/lib/script/script-quality';

const BEAT_PAUSE_SECONDS = 0.5;
const button =
  'px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json as T;
}

// --------------------------------------------------------------------------
// Runtime meter
// --------------------------------------------------------------------------

export function RuntimeMeter({ beats, targetMinutes }: { beats: ScriptBeat[]; targetMinutes?: number }) {
  const seconds = beats.reduce((s, b) => s + estimateSpeechSeconds(b.text), 0) + beats.length * BEAT_PAUSE_SECONDS;
  if (!targetMinutes) {
    return <span className="text-xs text-zinc-400">≈ {formatTime(seconds)} runtime</span>;
  }
  const target = targetMinutes * 60;
  const ratio = seconds / target;
  const tone =
    ratio < 0.9 || ratio > 1.1 ? 'text-amber-300 bg-amber-500/10 border-amber-500/30' : 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30';
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-lg border ${tone}`} title="Narration at ~2.3 words/sec plus a 0.5s pause between beats">
      ⏱ {formatTime(seconds)} of {formatTime(target)} target ({Math.round(ratio * 100)}%)
    </span>
  );
}

// --------------------------------------------------------------------------
// Beat rewrite
// --------------------------------------------------------------------------

const QUICK_ACTIONS: Array<{ label: string; instruction: string }> = [
  { label: '⚡ Punchier', instruction: 'Make it punchier: stronger verbs, shorter sentences, sharper rhythm.' },
  { label: '🧒 Simpler', instruction: 'Make it simpler to follow by ear, with no jargon.' },
  { label: '✂️ Shorter', instruction: 'Cut it to about half the words while keeping the key point.' },
  { label: '🎨 More vivid', instruction: 'Make it more vivid and concrete: a specific image, person, or moment.' },
  { label: '📌 Add a fact', instruction: 'Strengthen it with one specific researched fact that fits here.' },
  { label: '🔗 Smoother link', instruction: 'Improve how it flows from the previous beat and sets up the next one.' },
];

export function BeatRewritePanel({
  videoId,
  beats,
  index,
  initialInstruction,
  onApply,
  onClose,
}: {
  videoId: string;
  beats: ScriptBeat[];
  index: number;
  initialInstruction?: string;
  onApply: (beat: ScriptBeat) => void;
  onClose: () => void;
}) {
  const [instruction, setInstruction] = useState(initialInstruction ?? '');
  const [variants, setVariants] = useState<BeatVariant[]>([]);
  // A fix suggested by the script doctor starts generating as soon as the panel opens
  const [isLoading, setIsLoading] = useState(Boolean(initialInstruction));
  const [error, setError] = useState<string | null>(null);

  const request = (text: string) =>
    postJson<{ variants: BeatVariant[] }>(`/api/videos/${videoId}/script/beats/${index}/rewrite`, {
      instruction: text,
      beats,
    })
      .then((json) => setVariants(json.variants))
      .catch((err) => setError(err instanceof Error ? err.message : 'Rewrite failed'))
      .finally(() => setIsLoading(false));

  function generate(text: string) {
    setIsLoading(true);
    setError(null);
    setVariants([]);
    void request(text);
  }

  useEffect(() => {
    if (initialInstruction) void request(initialInstruction);
    // Runs once per panel; the parent remounts the panel (new key) for each new fix
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-xl border border-indigo-800/60 bg-indigo-950/20 p-3.5 space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-indigo-200">✨ Rewrite beat #{index + 1}</span>
        <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
          Close
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.label}
            type="button"
            disabled={isLoading}
            onClick={() => {
              setInstruction(a.instruction);
              void generate(a.instruction);
            }}
            className={`${button} bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border-zinc-700`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && instruction.trim() && !isLoading) void generate(instruction);
          }}
          placeholder="Or describe the change, e.g. 'end on a question that sets up the bank failures'"
          className="flex-1 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <button
          type="button"
          disabled={isLoading || !instruction.trim()}
          onClick={() => generate(instruction)}
          className={`${button} bg-indigo-600 hover:bg-indigo-500 text-white border-indigo-500`}
        >
          {isLoading ? 'Writing…' : 'Generate'}
        </button>
      </div>
      {isLoading && <p className="text-zinc-400">Writing 3 variants with the full script and research in view. This can take a minute or two.</p>}
      {error && <p className="text-red-300">{error}</p>}
      {variants.length > 0 && (
        <div className="space-y-2">
          {variants.map((v, i) => (
            <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-zinc-300">{v.angle}</span>
                <span className="flex items-center gap-2">
                  {v.beat.needs_check && <span className="text-amber-300">⚠ unsourced specifics</span>}
                  {(v.beat.fact_ids ?? []).length > 0 && (
                    <span className="font-mono text-indigo-300">{v.beat.fact_ids!.join(' ')}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => onApply(v.beat)}
                    className={`${button} bg-emerald-700 hover:bg-emerald-600 text-white border-emerald-600`}
                  >
                    Use this
                  </button>
                </span>
              </div>
              <p className="text-sm text-zinc-100 leading-relaxed">{v.beat.text}</p>
              <p className="text-zinc-500 font-mono">
                {v.beat.visual_type}: {v.beat.visual_query}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Hook lab
// --------------------------------------------------------------------------

const TECHNIQUE_LABEL: Record<HookOption['technique'], string> = {
  cold_open: '🎬 Cold open',
  shock_stat: '📈 Shock stat',
  question: '❓ Burning question',
  contrarian: '🔄 Contrarian',
};

export function HookLab({
  videoId,
  beats,
  onApply,
}: {
  videoId: string;
  beats: ScriptBeat[];
  onApply: (beat: ScriptBeat) => void;
}) {
  const [hooks, setHooks] = useState<HookOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setIsLoading(true);
    setError(null);
    try {
      const json = await postJson<{ hooks: HookOption[] }>(`/api/videos/${videoId}/script/hooks`, { beats });
      setHooks(json.hooks);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Hook generation failed');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="rounded-xl bg-zinc-950/60 border border-zinc-800 p-3.5 text-xs space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-zinc-200 font-semibold">🎣 Hook lab</span>
          <p className="text-zinc-500 mt-0.5">The first 8 seconds decide whether viewers stay. Compare 4 techniques against your current opening.</p>
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={isLoading || beats.length === 0}
          className={`${button} bg-rose-950/60 hover:bg-rose-900/70 text-rose-200 border-rose-800`}
        >
          {isLoading ? 'Writing hooks…' : hooks.length ? 'New hooks' : 'Generate hooks'}
        </button>
      </div>
      {error && <p className="text-red-300">{error}</p>}
      {hooks.length > 0 && (
        <div className="space-y-2">
          <div className="rounded-lg border border-zinc-800 p-3">
            <span className="text-zinc-500 uppercase tracking-wider text-[10px]">Current hook</span>
            <p className="text-sm text-zinc-300 mt-1">{beats[0]?.text}</p>
          </div>
          {hooks.map((hook) => (
            <div key={hook.technique} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-rose-200">{TECHNIQUE_LABEL[hook.technique]}</span>
                <button
                  type="button"
                  onClick={() => onApply(hook.beat)}
                  className={`${button} bg-emerald-700 hover:bg-emerald-600 text-white border-emerald-600`}
                >
                  Use this hook
                </button>
              </div>
              <p className="text-sm text-zinc-100 leading-relaxed">{hook.beat.text}</p>
              <p className="text-zinc-500">
                {hook.whyItWorks}
                {hook.beat.needs_check && <span className="text-amber-300"> · ⚠ unsourced specifics</span>}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Script doctor
// --------------------------------------------------------------------------

const DIMENSION_LABEL: Record<ScriptReview['scores'][number]['dimension'], string> = {
  hook: 'Hook',
  open_loops: 'Open loops',
  rehooks: 'Re-hooks',
  pacing: 'Pacing',
  clarity: 'Clarity',
  payoff: 'Payoff',
};
const SEVERITY_STYLE = {
  high: 'text-red-300 border-red-800 bg-red-950/40',
  medium: 'text-amber-300 border-amber-800 bg-amber-950/30',
  low: 'text-zinc-300 border-zinc-700 bg-zinc-900',
} as const;
const scoreColor = (n: number) => (n >= 8 ? 'bg-emerald-500' : n >= 6 ? 'bg-amber-400' : 'bg-red-500');

export function ScriptDoctor({
  videoId,
  beats,
  review,
  onReviewed,
  onFix,
}: {
  videoId: string;
  beats: ScriptBeat[];
  review: ScriptReview | undefined;
  onReviewed: (review: ScriptReview) => void;
  onFix: (beatIndex: number, instruction: string) => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stale = review ? review.basedOn !== scriptTextSignature(beats) : false;

  async function run() {
    setIsLoading(true);
    setError(null);
    try {
      const json = await postJson<{ review: ScriptReview }>(`/api/videos/${videoId}/script/review`, { beats });
      onReviewed(json.review);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review failed');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="rounded-xl bg-zinc-950/60 border border-zinc-800 p-3.5 text-xs space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-zinc-200 font-semibold">🩺 Script doctor</span>
          <p className="text-zinc-500 mt-0.5">A retention review: scores, plus the weakest beats with a one-click fix.</p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={isLoading || beats.length === 0}
          className={`${button} bg-sky-950/60 hover:bg-sky-900/70 text-sky-200 border-sky-800`}
        >
          {isLoading ? 'Reviewing…' : review ? 'Review again' : 'Review script'}
        </button>
      </div>
      {error && <p className="text-red-300">{error}</p>}
      {review && (
        <div className="space-y-3">
          {stale && <p className="text-amber-300">The script changed since this review. Run it again for current advice.</p>}
          {(review.warnings ?? []).length > 0 && (
            <ul className="space-y-1 rounded-lg border border-amber-800/60 bg-amber-950/20 p-2.5 text-amber-200">
              {review.warnings.map((w) => (
                <li key={w}>⚠ {w}</li>
              ))}
            </ul>
          )}
          <div className="flex items-start gap-4">
            <div className="text-center shrink-0">
              <div className="text-3xl font-bold text-white">{review.overall}</div>
              <div className="text-zinc-500">/ 10</div>
            </div>
            <p className="text-zinc-300 leading-relaxed">{review.summary}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            {review.scores.map((s) => (
              <div key={s.dimension} title={s.note}>
                <div className="flex justify-between text-zinc-400">
                  <span>{DIMENSION_LABEL[s.dimension]}</span>
                  <span className="font-mono text-zinc-200">{s.score}</span>
                </div>
                <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div className={`h-full ${scoreColor(s.score)}`} style={{ width: `${s.score * 10}%` }} />
                </div>
                <p className="text-zinc-500 mt-0.5">{s.note}</p>
              </div>
            ))}
          </div>
          {review.issues.length > 0 && (
            <ol className="space-y-1.5">
              {review.issues.map((issue, i) => (
                <li key={i} className={`rounded-lg border p-2.5 flex items-start justify-between gap-3 ${SEVERITY_STYLE[issue.severity]}`}>
                  <span>
                    <span className="font-semibold">Beat #{issue.beatIndex + 1}:</span> {issue.problem}
                    <span className="block text-zinc-400 mt-0.5">Fix: {issue.fixInstruction}</span>
                  </span>
                  <button
                    type="button"
                    disabled={issue.beatIndex >= beats.length}
                    onClick={() => onFix(issue.beatIndex, issue.fixInstruction)}
                    className={`${button} shrink-0 bg-zinc-900 hover:bg-zinc-800 text-zinc-100 border-zinc-700`}
                  >
                    Fix with AI
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
