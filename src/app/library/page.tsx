'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface Clip {
  id: string;
  name: string;
  isVideo: boolean;
  durationSec: number;
  description: string;
  tags: string[];
  license: string;
  addedAt: string;
}

const LICENSES = [
  { id: 'own_work', label: 'My own work' },
  { id: 'purchased', label: 'Purchased / licensed' },
  { id: 'royalty_free', label: 'Royalty-free' },
  { id: 'public_domain', label: 'Public domain' },
  { id: 'cc0', label: 'CC0' },
  { id: 'cc_by', label: 'CC BY (needs credit)' },
];

/**
 * The creator's clip library: footage and photos added once, described by what they show, and
 * offered by the footage picker for every video (the relevance check still decides).
 */
export default function LibraryPage() {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [license, setLicense] = useState('own_work');
  const [attribution, setAttribution] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const fetchClips = useCallback(() => fetch('/api/library').then((r) => r.json()) as Promise<{ clips?: Clip[] }>, []);
  const load = useCallback(async () => {
    setClips((await fetchClips()).clips ?? []);
  }, [fetchClips]);

  useEffect(() => {
    let cancelled = false;
    fetchClips()
      .then((body) => {
        if (!cancelled) setClips(body.clips ?? []);
      })
      .catch(() => {
        if (!cancelled) setClips([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchClips]);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    const list = Array.from(files);
    for (const [i, file] of list.entries()) {
      setProgress(`Adding ${i + 1} of ${list.length}: ${file.name} (looking at it to describe it)…`);
      const form = new FormData();
      form.append('file', file);
      form.append('license_type', license);
      if (attribution.trim()) form.append('attribution_text', attribution.trim());
      const res = await fetch('/api/library', { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error || `Could not add ${file.name}`);
      await load();
    }
    setProgress(null);
  }

  async function remove(id: string) {
    if (!window.confirm('Remove this clip from the library? Videos already made with it keep it.')) return;
    await fetch(`/api/library/${id}`, { method: 'DELETE' });
    await load();
  }

  const shown = (clips ?? []).filter((c) => {
    const q = filter.trim().toLowerCase();
    return !q || `${c.name} ${c.description} ${c.tags.join(' ')}`.toLowerCase().includes(q);
  });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div>
          <Link href="/" className="text-xs text-zinc-400 hover:text-zinc-200">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-bold text-white mt-1">Clip library</h1>
          <p className="text-xs text-zinc-400">
            Your own and licensed footage, added once. Each clip is described by what it shows, and the footage picker offers it
            for every video when it fits a shot.
          </p>
        </div>

        <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-zinc-400">Licence for what you add:</span>
            <select value={license} onChange={(e) => setLicense(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1">
              {LICENSES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            {license === 'cc_by' && (
              <input
                value={attribution}
                onChange={(e) => setAttribution(e.target.value)}
                placeholder="Credit, e.g. Footage: Jane Doe (CC BY 4.0)"
                className="flex-1 min-w-60 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1"
              />
            )}
            <label className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium cursor-pointer">
              + Add clips or photos
              <input
                type="file"
                multiple
                accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  add(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          {progress && <p className="text-indigo-200">{progress}</p>}
          {error && <p className="text-red-300">{error}</p>}
        </div>

        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by subject, tag or name"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm"
        />

        {clips === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-zinc-500 italic">{clips.length ? 'Nothing matches that filter.' : 'The library is empty. Add your first clips above.'}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {shown.map((c) => (
              <div key={c.id} className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden text-xs">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/library/${c.id}/thumb`} alt={c.description} className="w-full aspect-video object-cover bg-black" />
                <div className="p-3 space-y-1.5">
                  <p className="text-zinc-200">{c.description}</p>
                  <p className="text-zinc-500">
                    {c.isVideo ? `Video, ${Math.round(c.durationSec)} s` : 'Photo'} · {LICENSES.find((l) => l.id === c.license)?.label ?? c.license}
                  </p>
                  {c.tags.length > 0 && <p className="text-zinc-400">{c.tags.join(' · ')}</p>}
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-zinc-600 truncate max-w-40" title={c.name}>
                      {c.name}
                    </span>
                    <button type="button" onClick={() => remove(c.id)} className="text-red-300 hover:text-red-200 cursor-pointer">
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
