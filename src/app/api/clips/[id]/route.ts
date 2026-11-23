import { NextResponse } from 'next/server';
import { z } from 'zod';
import { loadChannelProfile } from '@/pipeline/channel/store';
import { composeUploadDescription, writeUploadInfo } from '@/pipeline/clipping/package';
import { fitEffects, fitHeader } from '@/pipeline/clipping/reaction';
import type { ClipPlan } from '@/pipeline/clipping/types';
import { isClipBusy } from '@/pipeline/clipping/run';
import { clipDir, deleteClip, loadClip, updateClip } from '@/pipeline/clipping/store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const clip = await loadClip(id);
  if (!clip) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
  return NextResponse.json({ clip, busy: isClipBusy(id), uploadDescription: clip.plan ? composeUploadDescription(clip, await loadChannelProfile()) : '' });
}

const VoiceLineEdit = z.object({
  at: z.number().min(0),
  text: z.string().max(300),
  slot: z.enum(['hook', 'build', 'after', 'other']).default('other'),
  audioFile: z.string().optional(),
  audioKey: z.string().optional(),
  durationSec: z.number().optional(),
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).optional(),
});

const MemeFileEdit = z.object({
  // Only files the meme finder wrote into the clip folder
  file: z.string().regex(/^memes\/[\w.-]+\.mp4$/),
  source: z.enum(['library', 'klipy', 'giphy', 'tenor']),
  title: z.string().max(200),
  origin: z.string().max(500),
  hasAudio: z.boolean(),
  durationSec: z.number().min(0),
  key: z.string().max(200),
});

const SoundFileEdit = z.object({
  // Only files the sound finder wrote into the clip folder
  file: z.string().regex(/^sounds\/[\w.-]+\.wav$/),
  source: z.enum(['library', 'builtin']),
  title: z.string().max(200),
  origin: z.string().max(500),
  durationSec: z.number().min(0),
  key: z.string().max(200),
});

const Point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

const CutInEdit = z.object({
  kind: z.enum(['meme', 'freeze', 'replay', 'ramp', 'skull']),
  at: z.number().min(0),
  durationSec: z.number().min(0).max(6),
  query: z.string().max(80).optional(),
  pick: z.number().int().min(0).max(50).optional(),
  meme: MemeFileEdit.optional(),
  replaySec: z.number().min(0.3).max(4).optional(),
  focus: Point.optional(),
  emoji: z.string().max(40).optional(),
});

const EffectEdit = z.object({
  at: z.number().min(0),
  kind: z.enum(['flash', 'shake', 'emoji', 'sound', 'comic']),
  emoji: z.string().max(16).optional(),
  query: z.string().max(80).optional(),
  sound: SoundFileEdit.optional(),
});

const PlanEdit = z
  .object({
    editStyle: z.enum(['classic', 'reaction']),
    header: z.object({ text: z.string().max(120), highlight: z.array(z.string().max(40)).max(5) }),
    cutIns: z.array(CutInEdit).max(8),
    effects: z.array(EffectEdit).max(12),
    zoomFocus: Point.nullable(),
    ending: z.object({ style: z.enum(['none', 'tbc', 'credits', 'stamp', 'skull', 'recap']), text: z.string().max(80), emoji: z.string().max(40).optional(), query: z.string().max(80).optional(), sound: SoundFileEdit.optional(), durationSec: z.number().min(0.5).max(6) }).nullable(),
    loop: z.boolean(),
    whipBlur: z.boolean(),
    grade: z.boolean(),
    glowCaptions: z.boolean(),
    hook: z.string().max(120),
    hookSec: z.number().min(0.5).max(10),
    overlays: z.array(z.object({ at: z.number().min(0), until: z.number().min(0), text: z.string().max(80) })).max(8),
    voiceLines: z.array(VoiceLineEdit).max(6),
    titles: z.array(z.string().max(100)).max(8),
    description: z.string().max(4000),
    tags: z.array(z.string().max(60)).max(30),
    peakSec: z.number().min(0).nullable(),
    layout: z.enum(['fit', 'crop', 'original']),
    trimStart: z.number().min(0),
    trimEnd: z.number().min(0),
    captions: z.boolean(),
    cleanCaptions: z.boolean(),
    showHook: z.boolean(),
    voiceover: z.boolean(),
    muteMusic: z.boolean(),
    zoomOnPeak: z.boolean(),
    sfxOnPeak: z.boolean(),
    voiceStyle: z.enum(['narrator', 'hype', 'info']),
    voice: z.string().max(80),
  })
  .partial();

const Edit = z.object({ creator: z.string().max(80).optional(), note: z.string().max(300).optional(), plan: PlanEdit.optional() });

/** Saves edits (they take effect on the next render). */
export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const parsed = Edit.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid edit' }, { status: 400 });
  const clip = await loadClip(id);
  if (!clip) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
  if (isClipBusy(id)) return NextResponse.json({ error: 'The clip is still being processed' }, { status: 409 });
  const { creator, note, plan } = parsed.data;
  if (plan && !clip.plan) return NextResponse.json({ error: 'The clip has no plan yet' }, { status: 409 });

  const updated = await updateClip(id, (p) => {
    if (creator !== undefined) p.creator = creator.trim();
    if (note !== undefined) p.note = note.trim();
    if (plan && p.plan) {
      // null clears the zoom aim (back to the centre) and the ending
      const { zoomFocus, ending, ...rest } = plan;
      const next: ClipPlan = { ...p.plan, ...rest };
      if (zoomFocus !== undefined) next.zoomFocus = zoomFocus ?? undefined;
      if (ending !== undefined) next.ending = ending && ending.style !== 'none' ? ending : undefined;
      const duration = p.analysis?.durationSec ?? next.trimEnd;
      next.trimStart = Math.min(Math.max(0, next.trimStart), Math.max(0, duration - 1));
      next.trimEnd = Math.min(duration, Math.max(next.trimStart + 1, next.trimEnd));
      next.voiceLines = next.voiceLines.filter((l) => l.text.trim()).sort((a, b) => a.at - b.at);
      next.overlays = next.overlays.filter((o) => o.text.trim()).map((o) => ({ ...o, until: Math.max(o.until, o.at + 0.5) }));
      next.titles = next.titles.map((t) => t.trim()).filter(Boolean);
      next.tags = next.tags.map((t) => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
      if (next.editStyle === 'reaction') {
        // Switching an older clip over: start from its hook and a hit on the big moment
        next.header = next.header ?? fitHeader(undefined, next.hook);
        next.effects = next.effects ?? fitEffects([], next.trimStart, next.trimEnd, next.peakSec);
        next.cutIns = (next.cutIns ?? []).filter((c) => c.kind !== 'meme' || c.query?.trim()).sort((a, b) => a.at - b.at);
      }
      p.plan = next;
    }
  });
  const channel = await loadChannelProfile();
  if (updated.output) await writeUploadInfo(clipDir(id), updated, channel);
  return NextResponse.json({ clip: updated, uploadDescription: updated.plan ? composeUploadDescription(updated, channel) : '' });
}

export async function DELETE(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (isClipBusy(id)) return NextResponse.json({ error: 'The clip is still being processed' }, { status: 409 });
  return (await deleteClip(id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Clip not found' }, { status: 404 });
}
