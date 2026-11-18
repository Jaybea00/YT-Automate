import { NextResponse } from 'next/server';
import { enqueueClip, isClipBusy, type ClipRunFrom } from '@/pipeline/clipping/run';
import { loadClip, updateClip } from '@/pipeline/clipping/store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const STEPS: ClipRunFrom[] = ['all', 'script', 'render'];

/**
 * Runs the clip again: { from: "render" } after edits, "script" for a fresh script (optionally in
 * another voiceStyle), "all" to start over from the download.
 */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = (await req.json().catch(() => ({}))) as { from?: string; voiceStyle?: string };
  const from = (STEPS.includes(body.from as ClipRunFrom) ? body.from : 'render') as ClipRunFrom;
  const clip = await loadClip(id);
  if (!clip) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
  if (isClipBusy(id)) return NextResponse.json({ error: 'The clip is already being processed' }, { status: 409 });
  await updateClip(id, (p) => {
    if (p.plan && (body.voiceStyle === 'narrator' || body.voiceStyle === 'hype' || body.voiceStyle === 'info')) p.plan.voiceStyle = body.voiceStyle;
    p.status = 'queued';
    p.step = 'Waiting to start';
    delete p.error;
  });
  enqueueClip(id, from);
  return NextResponse.json({ ok: true });
}
