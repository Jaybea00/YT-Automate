'use client';

import React, { useEffect, useState } from 'react';

interface AssemblyExtras {
  endScreen: { enabled: boolean; seconds: number; text: string };
  pacingFromRetention: boolean;
  retentionReady: boolean;
  tightened: number[];
  loosened: number[];
}

const beatList = (beats: number[]) => beats.map((b) => b + 1).join(', ');

/** The end screen and retention-based pacing, saved as they change. */
export function AssemblyExtrasCard({ videoId }: { videoId: string }) {
  const [data, setData] = useState<AssemblyExtras | null>(null);
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/videos/${videoId}/assembly/settings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: AssemblyExtras | null) => {
        if (live && d) setData(d);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [videoId]);

  async function save(update: { endScreen?: Partial<AssemblyExtras['endScreen']>; pacingFromRetention?: boolean }) {
    setSaving(true);
    try {
      const r = await fetch(`/api/videos/${videoId}/assembly/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      if (r.ok) setData((await r.json()) as AssemblyExtras);
    } finally {
      setSaving(false);
    }
  }

  if (!data) return null;
  const { endScreen } = data;
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-white">Ending &amp; pacing</h3>
        {saving && <span className="text-[11px] text-zinc-500">Saving…</span>}
      </div>

      <div className="space-y-3">
        <label className="flex items-start gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={endScreen.enabled}
            onChange={(e) => save({ endScreen: { enabled: e.target.checked } })}
            className="accent-indigo-500 mt-0.5"
          />
          <span>
            <span className="text-zinc-200 font-semibold">End screen</span>
            <span className="text-zinc-500">
              {' '}
              (the last shot, blurred, with the music carrying on: room for YouTube&apos;s &quot;watch next&quot; and subscribe boxes, which you add in YouTube Studio)
            </span>
          </span>
        </label>
        {endScreen.enabled && (
          <div className="pl-6 space-y-3">
            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-zinc-400">
                <span>Length</span>
                <span className="text-zinc-200 font-semibold">{endScreen.seconds}s</span>
              </div>
              <input
                type="range"
                min={5}
                max={20}
                step={1}
                defaultValue={endScreen.seconds}
                key={endScreen.seconds}
                onMouseUp={(e) => save({ endScreen: { seconds: Number((e.target as HTMLInputElement).value) } })}
                onTouchEnd={(e) => save({ endScreen: { seconds: Number((e.target as HTMLInputElement).value) } })}
                onKeyUp={(e) => save({ endScreen: { seconds: Number((e.target as HTMLInputElement).value) } })}
                className="w-full accent-indigo-500"
              />
              <p className="text-[10px] text-zinc-500">YouTube allows end-screen boxes in the last 5 to 20 seconds.</p>
            </div>
            <div className="space-y-1">
              <span className="text-[11px] text-zinc-400">Heading (leave empty for none)</span>
              <input
                value={text ?? endScreen.text}
                maxLength={60}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => {
                  if (text !== null && text !== endScreen.text) void save({ endScreen: { text } });
                  setText(null);
                }}
                className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-xs text-zinc-100"
              />
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2 pt-4 border-t border-zinc-800/80">
        <label className="flex items-start gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={data.pacingFromRetention}
            onChange={(e) => save({ pacingFromRetention: e.target.checked })}
            className="accent-indigo-500 mt-0.5"
          />
          <span>
            <span className="text-zinc-200 font-semibold">Tighten pauses from the retention check</span>
            <span className="text-zinc-500"> (shorter pauses after beats viewers would skip, a little more room after gripping ones; chapter changes keep theirs)</span>
          </span>
        </label>
        <p className="pl-6 text-[11px] text-zinc-400">
          {!data.retentionReady
            ? 'Run the retention check on the script page first (it must match the current beats).'
            : !data.pacingFromRetention
              ? 'Off: every beat uses the standard pause.'
              : data.tightened.length || data.loosened.length
                ? [
                    data.tightened.length ? `Shorter after beats ${beatList(data.tightened)}` : '',
                    data.loosened.length ? `more room after beats ${beatList(data.loosened)}` : '',
                  ]
                    .filter(Boolean)
                    .join('; ') + '. Changed beats are rebuilt at the next render.'
                : 'The check found nothing to tighten.'}
        </p>
      </div>
    </div>
  );
}
