'use client';

import React, { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ActionBar } from '@/components/ui/action-bar';
import { Card as UiCard } from '@/components/ui/card';
import { PageContainer, PageHeader, EmptyState } from '@/components/ui/page';
import { buttonClass } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

interface PublishData {
  videoId: string;
  rendered: boolean;
  hasTimeline: boolean;
  titles: Array<{ text: string; angle: string }>;
  title: string;
  description: string;
  generatedDescription: string;
  tags: string[];
  hashtags: string[];
  chapters: string;
  credits: string;
  thumbnails: Array<{ n: number; text: string; atSec: number }>;
  shorts: Array<{ n: number; title: string; hook: string; startSec: number; endSec: number }>;
  edited: boolean;
  metadataGeneratedAt: string | null;
  /** 'short' when this video is a native Short made from a long video. */
  format: 'short' | null;
  parentVideoId: string | null;
  nativeShorts: Array<{
    id: string;
    title: string;
    hook: string;
    angle: string;
    promise: string;
    video_id?: string;
    status: string | null;
  }>;
  packagingScore: PackagingScore | null;
}

/** Every title with every thumbnail, scored against the niche (see packaging-score.ts). */
interface PackagingScore {
  scoredAt: string;
  query: string;
  competitors: Array<{ id: string; title: string; channel: string; views: number; thumbUrl: string }>;
  titles: string[];
  thumbnailTexts: string[];
  pairs: Array<{ title: number; thumbnail: number; score: number; reason: string }>;
  best: Array<{ title: number; thumbnail: number }>;
  niche: string;
  advice: string[];
  /** False once the titles or thumbnails changed after scoring. */
  current: boolean;
}

const scoreClass = (n: number) =>
  n >= 8 ? 'bg-emerald-950 text-emerald-300 border-emerald-800' : n >= 6 ? 'bg-amber-950 text-amber-300 border-amber-800' : 'bg-red-950 text-red-300 border-red-900';
const shortViews = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

const STATUS_LABEL: Record<string, string> = {
  scripting: 'Writing…',
  script_review: 'Script ready to review',
  voicing: 'Voicing',
  sourcing: 'Visuals',
  assembling: 'Assembling',
  rendered: 'Rendered',
  published: 'Published',
  failed: 'Failed',
  deleted: 'Deleted',
};

const TITLE_IDEAL = 60;
const TAGS_MAX = 500;

const tagCost = (tags: string[]) => tags.reduce((n, t, i) => n + t.length + (t.includes(' ') ? 2 : 0) + (i ? 1 : 0), 0);

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard unavailable; the text is selectable
        }
      }}
      className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[11px] font-medium transition"
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}

function Card({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <UiCard title={title} actions={actions}>
      <div className="space-y-4">{children}</div>
    </UiCard>
  );
}

/**
 * Everything to publish the video in YouTube Studio: title options, description (with chapters,
 * credits and hashtags), tags, thumbnails for A/B testing, Shorts, subtitles, and one download
 * with all of it.
 */
export default function PublishPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<PublishData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Shorts: footage fills the vertical frame, following the subject
  const [reframe, setReframe] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('');
  // Bumped after each regeneration so the browser fetches the new thumbnails and Shorts
  const [version, setVersion] = useState(0);

  const apply = useCallback((d: PublishData) => {
    setData(d);
    setTitle(d.title);
    setDescription(d.description);
    setTagsText(d.tags.join(', '));
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/videos/${id}/publish`)
      .then(async (res) => ({ ok: res.ok, body: await res.json() }))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (ok) apply(body);
        else setError(body.error || 'Could not load');
      })
      .catch(() => !cancelled && setError('Could not load'));
    return () => {
      cancelled = true;
    };
  }, [id, apply]);

  const run = async (key: string, label: string, url: string, init: RequestInit = { method: 'POST' }) => {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(url, init);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Something went wrong');
      apply(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
    return key;
  };

  // Writing a Short takes a while; the response carries the updated view and the new video's id
  const makeShort = async (ideaId: string) => {
    setBusy('Writing the Short and creating its video… (a minute or two)');
    setError(null);
    try {
      const res = await fetch(`/api/videos/${id}/publish/native-shorts/${ideaId}`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Something went wrong');
      apply(body.view);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const tags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);
  const dirty = data && (title !== data.title || description !== data.description || tags.join(',') !== data.tags.join(','));
  const save = () =>
    run('save', 'Saving…', `/api/videos/${id}/publish`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, tags }),
    });

  if (!data) {
    return (
      <PageContainer>
        <EmptyState loading={!error} title={error ?? 'Loading the publish tools…'} />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
        <PageHeader
          title="Publish"
          description="Everything to paste into YouTube Studio, plus one download with all of it."
          actions={
            <>
              <a
                href={data.hasTimeline ? `/api/videos/${id}/publish/resolve` : undefined}
                aria-disabled={!data.hasTimeline}
                title="The edit for DaVinci Resolve (free): picture, narration, music and effects on their own tracks, plus captions"
                className={buttonClass('secondary', 'md', data.hasTimeline ? '' : 'opacity-50 pointer-events-none')}
              >
                Export for DaVinci Resolve
              </a>
              <a
                href={data.rendered ? `/api/videos/${id}/publish/package` : undefined}
                aria-disabled={!data.rendered}
                className={buttonClass('primary', 'md', data.rendered ? '' : 'opacity-50 pointer-events-none')}
              >
                <Icon name="download" size={16} />
                Download package (.zip)
              </a>
            </>
          }
        />

        {data.format === 'short' && (
          <div className="px-4 py-3 rounded-xl bg-red-950/30 border border-red-800/60 text-red-100 text-sm">
            This is a native Short. &quot;Render vertical Short&quot; below turns the whole video into one 9:16 Short.
            {data.parentVideoId && (
              <>
                {' '}
                <Link href={`/videos/${data.parentVideoId}/publish`} className="underline text-red-300">Back to the full video</Link>
              </>
            )}
          </div>
        )}
        {busy && <div className="px-4 py-2 rounded-xl bg-indigo-950/60 border border-indigo-800 text-indigo-200 text-sm">{busy}</div>}
        {error && <div className="px-4 py-2 rounded-xl bg-red-950/60 border border-red-800 text-red-200 text-sm">{error}</div>}
        {!data.rendered && (
          <div className="px-4 py-3 rounded-xl bg-amber-950/50 border border-amber-800 text-amber-200 text-sm">
            The video hasn&apos;t been rendered yet. Run assembly first; titles, thumbnails and Shorts are made from the finished video.
          </div>
        )}
        {data.rendered && !data.hasTimeline && (
          <div className="px-4 py-3 rounded-xl bg-amber-950/50 border border-amber-800 text-amber-200 text-sm">
            This render predates the publishing tools. Re-run assembly to get thumbnails, Shorts and word-timed subtitles.
          </div>
        )}

        <Card
          title="Title"
          actions={
            <>
              <CopyButton text={title} />
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => run('meta', 'Writing new titles, description and tags… (about 20 seconds)', `/api/videos/${id}/publish/metadata`)}
                className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[11px] font-medium disabled:opacity-50"
              >
                ↻ Regenerate text
              </button>
            </>
          }
        >
          {data.titles.length > 0 && (
            <div className="grid gap-2">
              {data.titles.map((t) => (
                <button
                  key={t.text}
                  type="button"
                  onClick={() => setTitle(t.text)}
                  className={`text-left px-3 py-2 rounded-xl border text-sm transition ${
                    title === t.text ? 'bg-indigo-950/40 border-indigo-500/80 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                  }`}
                >
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500 mr-2">{t.angle}</span>
                  {t.text}
                  <span className={`ml-2 text-[10px] ${t.text.length > TITLE_IDEAL ? 'text-amber-400' : 'text-zinc-500'}`}>{t.text.length}</span>
                </button>
              ))}
            </div>
          )}
          <input
            value={title}
            maxLength={100}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-indigo-500"
          />
          <p className={`text-[11px] ${title.length > TITLE_IDEAL ? 'text-amber-400' : 'text-zinc-500'}`}>
            {title.length}/100 characters{title.length > TITLE_IDEAL ? ' (titles over 60 can be cut off in search and suggestions)' : ''}
          </p>
        </Card>

        <Card
          title="Description"
          actions={
            <>
              <CopyButton text={description} />
              {data.generatedDescription && description !== data.generatedDescription && (
                <button
                  type="button"
                  onClick={() => setDescription(data.generatedDescription)}
                  className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[11px] font-medium"
                >
                  Reset
                </button>
              )}
            </>
          }
        >
          <textarea
            value={description}
            maxLength={5000}
            rows={14}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-700 text-zinc-100 text-sm font-mono focus:outline-none focus:border-indigo-500"
          />
          <p className="text-[11px] text-zinc-500">
            {description.length}/5,000 characters. The first two lines show above &quot;...more&quot;; chapters and the required credits are included.
          </p>
        </Card>

        <Card title="Tags" actions={<CopyButton text={tags.join(', ')} />}>
          <textarea
            value={tagsText}
            rows={3}
            onChange={(e) => setTagsText(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-indigo-500"
          />
          <p className={`text-[11px] ${tagCost(tags) > TAGS_MAX ? 'text-red-400' : 'text-zinc-500'}`}>
            {tags.length} tags, {tagCost(tags)}/{TAGS_MAX} characters (as YouTube counts them). Separate with commas.
          </p>
        </Card>

        {dirty && (
          <div className="sticky bottom-4 flex justify-end">
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={save}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold shadow-lg disabled:opacity-50"
            >
              Save changes
            </button>
          </div>
        )}

        <Card
          title={`Thumbnails (${data.thumbnails.length})`}
          actions={
            <button
              type="button"
              disabled={Boolean(busy) || !data.hasTimeline}
              onClick={() => run('thumbs', 'Picking frames and designing thumbnails… (under a minute)', `/api/videos/${id}/publish/thumbnails`)}
              className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[11px] font-medium disabled:opacity-50"
            >
              ↻ Regenerate
            </button>
          }
        >
          {data.thumbnails.length ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {data.thumbnails.map((t) => (
                  <div key={t.n} className="space-y-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/videos/${id}/publish/file?kind=thumbnail&n=${t.n}&v=${version}`} alt={t.text} className="w-full aspect-video rounded-lg border border-zinc-800 object-cover" />
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span>&ldquo;{t.text}&rdquo;</span>
                      <a href={`/api/videos/${id}/publish/file?kind=thumbnail&n=${t.n}&download=1`} className="text-indigo-400 hover:text-indigo-300">Download</a>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-zinc-500">Upload all three in YouTube Studio&apos;s &quot;Test &amp; compare&quot; to let YouTube pick the one viewers click most.</p>
            </>
          ) : (
            <p className="text-sm text-zinc-500 italic">No thumbnails yet.</p>
          )}
        </Card>

        {data.thumbnails.length > 0 && (data.titles.length > 0 || title) && (
          <Card
            title="Title & thumbnail pairs"
            actions={
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => run('score', 'Comparing every pair with the top videos on this topic… (under a minute)', `/api/videos/${id}/publish/score`)}
                className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[11px] font-medium disabled:opacity-50"
              >
                {data.packagingScore ? '↻ Score again' : 'Score the pairs'}
              </button>
            }
          >
            {!data.packagingScore ? (
              <p className="text-sm text-zinc-500">
                Scores every title with every thumbnail the way viewers meet them: small, in a feed next to the most-watched videos on this topic. It says which pairs to put up
                first in &quot;Test &amp; compare&quot; and what would lift the weaker ones.
              </p>
            ) : (
              (() => {
                const sc = data.packagingScore;
                const pairOf = (t: number, n: number) => sc.pairs.find((p) => p.title === t && p.thumbnail === n);
                return (
                  <div className="space-y-4">
                    {!sc.current && (
                      <p className="text-[11px] text-amber-300">The titles or thumbnails changed since this was scored: score again to compare the new ones.</p>
                    )}
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-zinc-300">Test these first</p>
                      {sc.best.map((b, i) => {
                        const p = pairOf(b.title, b.thumbnail);
                        const t = sc.titles[b.title] ?? '';
                        return (
                          <div key={`${b.title}-${b.thumbnail}`} className="flex gap-3 items-start rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`/api/videos/${id}/publish/file?kind=thumbnail&n=${b.thumbnail}&v=${version}`} alt="" className="w-32 aspect-video rounded border border-zinc-800 object-cover shrink-0" />
                            <div className="flex-1 min-w-0 space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] text-zinc-500">#{i + 1}</span>
                                {p && <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded border ${scoreClass(p.score)}`}>{p.score}/10</span>}
                                <span className="text-[11px] text-zinc-500">Thumbnail {b.thumbnail}</span>
                              </div>
                              <p className="text-sm text-zinc-100 font-medium">{t}</p>
                              {p && <p className="text-[11px] text-zinc-400">{p.reason}</p>}
                            </div>
                            <button
                              type="button"
                              onClick={() => setTitle(t)}
                              disabled={title === t}
                              className="shrink-0 px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-[11px] font-semibold"
                              title="Puts this title in the Title box above (then Save)"
                            >
                              {title === t ? 'In use' : 'Use title'}
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="text-zinc-500">
                            <th className="text-left font-medium pb-1">Title</th>
                            {sc.thumbnailTexts.map((_, n) => (
                              <th key={n} className="font-medium pb-1 px-1 w-16">Thumb {n + 1}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sc.titles.map((t, ti) => (
                            <tr key={ti} className="border-t border-zinc-800/70">
                              <td className="py-1.5 pr-2 text-zinc-300">{t}</td>
                              {sc.thumbnailTexts.map((_, n) => {
                                const p = pairOf(ti, n + 1);
                                return (
                                  <td key={n} className="px-1 text-center">
                                    {p ? (
                                      <span title={p.reason} className={`inline-block min-w-[2.5rem] font-bold px-1.5 py-0.5 rounded border ${scoreClass(p.score)}`}>
                                        {p.score}
                                      </span>
                                    ) : (
                                      <span className="text-zinc-600">–</span>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="text-[10px] text-zinc-500 pt-1">Hover a score for its reason.</p>
                    </div>

                    {(sc.niche || sc.advice.length > 0) && (
                      <div className="space-y-1 text-xs">
                        {sc.niche && (
                          <p className="text-zinc-400">
                            <span className="text-zinc-300 font-semibold">What the top videos do: </span>
                            {sc.niche}
                          </p>
                        )}
                        {sc.advice.length > 0 && (
                          <ul className="list-disc pl-4 text-zinc-400 space-y-0.5">
                            {sc.advice.map((a) => (
                              <li key={a}>{a}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                    {sc.competitors.length > 0 ? (
                      <div className="space-y-1">
                        <p className="text-[11px] text-zinc-500">Compared with the most-watched videos for &quot;{sc.query}&quot;:</p>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          {sc.competitors.map((c) => (
                            <a key={c.id} href={`https://www.youtube.com/watch?v=${c.id}`} target="_blank" rel="noreferrer" className="space-y-0.5 group">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={c.thumbUrl} alt="" className="w-full aspect-video rounded border border-zinc-800 object-cover group-hover:border-zinc-600" />
                              <p className="text-[10px] text-zinc-300 line-clamp-2">{c.title}</p>
                              <p className="text-[10px] text-zinc-500">
                                {c.channel} · {shortViews(c.views)} views
                              </p>
                            </a>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-[11px] text-zinc-500">Scored on their own: no niche videos were available (no YouTube key, or today&apos;s search allowance is used up).</p>
                    )}
                    <p className="text-[10px] text-zinc-600">Scored {new Date(sc.scoredAt).toLocaleString()}. A guide, not a promise: YouTube&apos;s own test decides.</p>
                  </div>
                );
              })()
            )}
          </Card>
        )}

        <Card
          title={`Shorts (${data.shorts.length})`}
          actions={
            <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-[11px] text-zinc-400" title="Footage fills the vertical frame and the crop follows the subject; charts, maps and text stay whole">
              <input type="checkbox" checked={reframe} onChange={(e) => setReframe(e.target.checked)} className="accent-indigo-500" />
              Follow the subject
            </label>
            <button
              type="button"
              disabled={Boolean(busy) || !data.hasTimeline}
              onClick={() =>
                run(
                  'shorts',
                  data.format === 'short' ? 'Rendering the vertical Short… (a few minutes)' : 'Choosing moments and cutting Shorts… (a few minutes)',
                  `/api/videos/${id}/publish/shorts`,
                  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reframe }) },
                )
              }
              className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-medium disabled:opacity-50"
            >
              {data.format === 'short'
                ? data.shorts.length
                  ? '↻ Render again'
                  : '▮ Render vertical Short'
                : data.shorts.length
                  ? '↻ Re-cut Shorts'
                  : '✂ Create Shorts'}
            </button>
            </div>
          }
        >
          {data.shorts.length ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {data.shorts.map((s) => (
                <div key={s.n} className="space-y-1.5">
                  <video
                    src={`/api/videos/${id}/publish/file?kind=short&n=${s.n}&v=${version}`}
                    controls
                    preload="metadata"
                    className="w-full aspect-[9/16] rounded-lg border border-zinc-800 bg-black"
                  />
                  <p className="text-xs text-zinc-200">{s.title} #Shorts</p>
                  <div className="flex items-center justify-between text-[11px] text-zinc-500">
                    <span>{(s.endSec - s.startSec).toFixed(0)}s from {Math.floor(s.startSec / 60)}:{String(Math.floor(s.startSec % 60)).padStart(2, '0')}</span>
                    <a href={`/api/videos/${id}/publish/file?kind=short&n=${s.n}&download=1`} className="text-indigo-400 hover:text-indigo-300">Download</a>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-500 italic">
              {data.format === 'short'
                ? 'Render this Short as a vertical 9:16 video with big captions and its hook banner.'
                : 'Cut 2-3 vertical Shorts from the strongest moments, captioned, with a pointer to the full video.'}
            </p>
          )}
        </Card>

        {data.format !== 'short' && (
          <Card
            title={`Native Shorts (${data.nativeShorts.length})`}
            actions={
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => run('native', 'Drafting Short ideas…', `/api/videos/${id}/publish/native-shorts`)}
                className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-medium disabled:opacity-50"
              >
                {data.nativeShorts.length ? '↻ New ideas' : '✍ Write native Shorts'}
              </button>
            }
          >
            {data.nativeShorts.length ? (
              <ul className="space-y-3">
                {data.nativeShorts.map((s) => (
                  <li key={s.id} className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800 space-y-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-sm text-zinc-100 font-semibold">{s.title}</p>
                      {s.video_id ? (
                        <Link
                          href={`/videos/${s.video_id}/${s.status === 'rendered' || s.status === 'published' ? 'publish' : 'review'}`}
                          className="text-[11px] text-indigo-300 hover:text-indigo-200 underline"
                        >
                          {STATUS_LABEL[s.status ?? ''] ?? s.status} · Open Short →
                        </Link>
                      ) : (
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() => makeShort(s.id)}
                          className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 text-[11px] disabled:opacity-50"
                        >
                          Make this Short
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-zinc-300">Hook: “{s.hook}”</p>
                    <p className="text-xs text-zinc-500 italic">
                      {s.angle} · {s.promise}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500 italic">
                Shorts written for the Shorts feed, each with its own hook, instead of clips of this video. Each one you pick becomes a
                small video of about 50 seconds that goes through script review, voice, visuals and assembly, then renders vertical.
              </p>
            )}
          </Card>
        )}

        <Card title="Subtitles">
          <div className="flex gap-2">
            <a href={`/api/videos/${id}/subtitles?format=srt&download=1`} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-xs">Download .srt</a>
            <a href={`/api/videos/${id}/subtitles?format=vtt&download=1`} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-xs">Download .vtt</a>
          </div>
          <p className="text-[11px] text-zinc-500">Upload the .srt under Subtitles in YouTube Studio for accurate captions (better than auto-captions for names and numbers).</p>
        </Card>

        <Card title="In YouTube Studio">
          <ol className="list-decimal list-inside text-sm text-zinc-300 space-y-1">
            <li>Upload the video, then paste the title, description and tags from this page.</li>
            <li>Under Thumbnail, choose &quot;Test &amp; compare&quot; and upload the three thumbnails.</li>
            <li>Under Subtitles, upload the .srt file.</li>
            <li>Add end screens in the last 5-20 seconds, then publish or schedule.</li>
            <li>Upload the Shorts with their titles, and link the full video from each Short.</li>
          </ol>
        </Card>

        {data.rendered && (
          <ActionBar hint="One zip with the video, thumbnails, Shorts, subtitles and the text to paste.">
            <a href={`/api/videos/${id}/publish/package`} className={buttonClass('primary')}>
              <Icon name="download" size={16} />
              Download package
            </a>
          </ActionBar>
        )}
    </PageContainer>
  );
}
