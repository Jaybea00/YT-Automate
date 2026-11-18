import { NextResponse } from 'next/server';
import { normalizeClipUrl } from '@/pipeline/clipping/ingest';
import { createClip, isClipBusy } from '@/pipeline/clipping/run';
import { listClips } from '@/pipeline/clipping/store';

/** Clip-to-Short projects, newest first. */
export async function GET() {
  const clips = await listClips();
  return NextResponse.json({
    clips: clips.map((c) => ({
      id: c.id,
      sourceUrl: c.sourceUrl,
      creator: c.creator || c.source?.uploaderHandle || c.source?.uploader || '',
      title: c.plan?.titles[0] || c.source?.title || c.sourceUrl,
      status: c.status,
      step: c.step,
      error: c.error ?? null,
      createdAt: c.createdAt,
      hasVideo: Boolean(c.output),
      busy: isClipBusy(c.id),
    })),
  });
}

/** Starts a new clip from a link: { url, creator?, note? }. Processing runs in the background. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { url?: string; creator?: string; note?: string } | null;
  const url = body?.url?.trim();
  if (!url) return NextResponse.json({ error: 'Paste a clip link' }, { status: 400 });
  try {
    normalizeClipUrl(url);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  const clip = await createClip({ url, creator: body?.creator?.slice(0, 80), note: body?.note?.slice(0, 300) });
  return NextResponse.json({ id: clip.id });
}
