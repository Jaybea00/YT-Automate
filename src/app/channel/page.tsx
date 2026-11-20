'use client';

import React, { useEffect, useState } from 'react';
import { Card, Panel } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageContainer, PageHeader } from '@/components/ui/page';
import {
  FONTS,
  PALETTES,
  VOICE_STYLES,
  cleanHashtags,
  descriptionFooter,
  formatCredit,
  type ChannelPalette,
  type ChannelProfile,
} from '@/lib/channel/profile';

const input = 'w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-semibold text-zinc-300">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500 leading-relaxed">{hint}</span>}
    </label>
  );
}

/** A phone-shaped preview of a Short's caption look: hook banner, a caption, the @handle. */
function ShortPreview({ p }: { p: ChannelProfile }) {
  const colours = PALETTES[p.palette];
  const font = `"${p.captionFont}", "Arial Black", sans-serif`;
  const outline = '0 0 4px #000, 2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000';
  return (
    <div className="relative mx-auto aspect-[9/16] w-full max-w-[220px] overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-b from-sky-900 via-fuchsia-900 to-orange-800">
      {p.handleMark && p.handle && (
        <span className={`absolute top-2.5 text-[9px] font-black text-white/75 ${p.handleMarkCorner === 'top-left' ? 'left-3' : 'right-3'}`} style={{ fontFamily: font, textShadow: '0 0 3px #000' }}>
          @{p.handle}
        </span>
      )}
      <p className="absolute inset-x-3 top-[9%] text-center text-[15px] font-black leading-tight" style={{ fontFamily: font, color: colours.banner, textShadow: outline }}>
        {p.closingAs === 'banner' && p.closingLine ? p.closingLine : 'WAIT FOR IT…'}
      </p>
      <p className="absolute inset-x-3 bottom-[24%] text-center text-[15px] font-black leading-tight text-white" style={{ fontFamily: font, textShadow: outline }}>
        he did <span style={{ color: colours.highlight }}>NOT</span> just
      </p>
    </div>
  );
}

/**
 * The channel profile: name and @handle, how the voiceover sounds, the look of every Short
 * (caption colours, font, closing line, @handle mark) and the end of every description.
 */
export default function ChannelPage() {
  const [saved, setSaved] = useState<ChannelProfile | null>(null);
  const [p, setP] = useState<ChannelProfile | null>(null);
  const [tagsText, setTagsText] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/channel')
      .then((r) => r.json())
      .then((d: { channel: ChannelProfile }) => {
        setSaved(d.channel);
        setP(d.channel);
        setTagsText(d.channel.hashtags.map((t) => `#${t}`).join(' '));
      })
      .catch(() => setError('Could not load the channel profile.'));
  }, []);

  if (!p) {
    return (
      <PageContainer width="wide">
        <EmptyState loading={!error} title={error || 'Loading the channel…'} />
      </PageContainer>
    );
  }

  const set = (change: Partial<ChannelProfile>) => {
    setP({ ...p, ...change });
    setStatus('idle');
  };
  const dirty = JSON.stringify({ ...p, hashtags: cleanHashtags(tagsText) }) !== JSON.stringify(saved);

  const save = async () => {
    setStatus('saving');
    setError('');
    try {
      const res = await fetch('/api/channel', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: { ...p, hashtags: cleanHashtags(tagsText) } }) });
      const data = (await res.json()) as { channel?: ChannelProfile; error?: string };
      if (!res.ok || !data.channel) throw new Error(data.error || 'Save failed');
      setSaved(data.channel);
      setP(data.channel);
      setTagsText(data.channel.hashtags.map((t) => `#${t}`).join(' '));
      setStatus('saved');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const preview = { ...p, hashtags: cleanHashtags(tagsText) };
  const sampleDescription = [
    'He tried to outrun the cops on a bike. It did not go well.',
    `${formatCredit(preview, '@clipcreator')} (https://x.com/…)`,
    descriptionFooter(preview, ['#GTA6FunnyMoments']),
  ].join('\n\n');

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Settings"
        title="Channel"
        description="Who your Shorts come from. Every new Short and compilation uses this: the script writer’s brief, the caption colours, the closing line and the end of the description."
        meta={
          <>
            <Badge tone="accent">{p.name}</Badge>
            {p.handle && <span>@{p.handle}</span>}
          </>
        }
        actions={
          <>
            {status === 'saved' && !dirty && <span className="text-xs text-emerald-400">Saved</span>}
            {status === 'error' && <span className="text-xs text-red-400">{error}</span>}
            <Button variant="primary" icon="check" onClick={save} disabled={!dirty || status === 'saving'}>
              {status === 'saving' ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <Card title="Profile" description="Your channel’s name, handle and what it posts.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Channel name">
                <input className={input} value={p.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Field label="Handle" hint="Your YouTube @handle, shown in the corner of every Short.">
                <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-950 focus-within:border-indigo-500">
                  <span className="pl-3 text-sm text-zinc-500">@</span>
                  <input className="w-full bg-transparent px-1 py-2 text-sm text-zinc-100 focus:outline-none" value={p.handle} maxLength={40} onChange={(e) => set({ handle: e.target.value.replace(/[@\s]/g, '') })} />
                </div>
              </Field>
              <div className="sm:col-span-2">
                <Field label="What the channel posts" hint="Told to the script writer so hooks and titles fit the channel.">
                  <input className={input} value={p.niche} maxLength={200} onChange={(e) => set({ niche: e.target.value })} />
                </Field>
              </div>
            </div>
          </Card>

          <Card title="Voice and tone" description="How the voiceover and the writing sound.">
            <div className="space-y-4">
              <Field label="Default voiceover style" hint="New Shorts start with this; you can still change it per Short.">
                <div className="flex flex-wrap gap-2">
                  {VOICE_STYLES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => set({ defaultVoiceStyle: s.id })}
                      className={`rounded-lg border px-3 py-1.5 text-sm ${p.defaultVoiceStyle === s.id ? 'border-indigo-500 bg-indigo-500/15 text-zinc-50' : 'border-zinc-800 text-zinc-400 hover:text-zinc-100'}`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Tone" hint="A sentence or two. The script writer follows it for hooks, voice lines and titles.">
                <textarea className={`${input} min-h-[72px]`} value={p.tone} maxLength={400} onChange={(e) => set({ tone: e.target.value })} />
              </Field>
              <Field label="Narrator voice" hint="A voice id from your narration provider (e.g. af_heart for Kokoro). Empty uses the narration stage’s default.">
                <input className={input} value={p.voice} maxLength={80} placeholder="default" onChange={(e) => set({ voice: e.target.value.trim() })} />
              </Field>
            </div>
          </Card>

          <Card title="Look of every Short" description="Caption colours and font, a closing line and your @handle.">
            <div className="space-y-4">
              <Field label="Colours">
                <div className="grid gap-2 sm:grid-cols-3">
                  {(Object.keys(PALETTES) as ChannelPalette[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => set({ palette: id })}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${p.palette === id ? 'border-indigo-500 bg-indigo-500/15 text-zinc-50' : 'border-zinc-800 text-zinc-400 hover:text-zinc-100'}`}
                    >
                      <span className="h-4 w-4 shrink-0 rounded-full" style={{ background: PALETTES[id].highlight }} />
                      <span className="h-4 w-4 shrink-0 rounded-full" style={{ background: PALETTES[id].banner }} />
                      <span className="min-w-0 truncate">{PALETTES[id].label}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Caption font">
                  <select className={input} value={p.captionFont} onChange={(e) => set({ captionFont: e.target.value as ChannelProfile['captionFont'] })}>
                    {FONTS.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </Field>
                <Field label="@handle in the corner">
                  <select
                    className={input}
                    value={p.handleMark ? p.handleMarkCorner : 'off'}
                    onChange={(e) => (e.target.value === 'off' ? set({ handleMark: false }) : set({ handleMark: true, handleMarkCorner: e.target.value as ChannelProfile['handleMarkCorner'] }))}
                  >
                    <option value="top-right">Top right</option>
                    <option value="top-left">Top left</option>
                    <option value="off">Off</option>
                  </select>
                </Field>
              </div>
              <Panel className="space-y-3">
                <label className="flex items-center gap-2 text-sm text-zinc-200">
                  <input type="checkbox" checked={p.closingAs === 'banner'} onChange={(e) => set({ closingAs: e.target.checked ? 'banner' : 'off' })} />
                  Closing line over the last 2.5 seconds
                </label>
                <input className={input} value={p.closingLine} maxLength={50} placeholder="Follow for daily GTA 6" onChange={(e) => set({ closingLine: e.target.value })} />
                <p className="text-xs text-zinc-500">Also the sign-off the voiceover ends a compilation with.</p>
              </Panel>
            </div>
          </Card>

          <Card title="Descriptions and hashtags" description="Added to the end of every description.">
            <div className="space-y-4">
              <Field label="Hashtags" hint="#Shorts is always added first on a Short. YouTube shows the first three above the title.">
                <input className={input} value={tagsText} onChange={(e) => { setTagsText(e.target.value); setStatus('idle'); }} placeholder="#GTA6 #GTAVI" />
              </Field>
              <Field label="Footer">
                <input className={input} value={p.footer} maxLength={300} onChange={(e) => set({ footer: e.target.value })} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Clip credit" hint="{creator} becomes the clip’s creator.">
                  <input className={input} value={p.creditFormat} maxLength={80} onChange={(e) => set({ creditFormat: e.target.value })} />
                </Field>
                <Field label="Fan-channel note">
                  <input className={input} value={p.fanNote} maxLength={200} onChange={(e) => set({ fanNote: e.target.value })} />
                </Field>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-20 lg:self-start">
          <Card title="Preview">
            <ShortPreview p={p} />
          </Card>
          <Card title="Description ends like this">
            <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-zinc-300">{sampleDescription}</pre>
          </Card>
          <p className="px-1 text-xs leading-relaxed text-zinc-500">
            Lucia and Jason are Rockstar’s GTA 6 characters. Keep the fan-channel note, and use your own banner and profile picture, not Rockstar’s logo or key art.
          </p>
        </div>
      </div>
    </PageContainer>
  );
}
