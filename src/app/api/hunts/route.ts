import { NextResponse } from 'next/server';
import { createHunt, isHuntBusy } from '@/pipeline/hunter/run';
import { normalizeStreamUrl } from '@/pipeline/hunter/source';
import { listHunts } from '@/pipeline/hunter/store';

/** Stream hunts, newest first. */
export async function GET() {
  const hunts = await listHunts();
  return NextResponse.json({
    hunts: hunts.map((h) => ({
      id: h.id,
      url: h.url,
      platform: h.platform,
      title: h.title || h.url,
      uploader: h.creator || h.uploaderHandle || h.uploader,
      durationSec: h.durationSec,
      status: h.status,
      step: h.step,
      progress: h.progress ?? null,
      error: h.error ?? null,
      createdAt: h.createdAt,
      moments: h.moments.filter((m) => !m.discarded).length,
      thumb: h.moments.find((m) => m.thumb && !m.discarded) ? { moment: h.moments.find((m) => m.thumb && !m.discarded)!.id } : null,
      busy: isHuntBusy(h.id),
    })),
  });
}

const MAX_CHAT_BYTES = 200 * 1024 * 1024;

/** Starts a hunt (form fields: url, creator?, maxMoments?, chat? = a TwitchDownloader chat JSON). */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const url = String(form.get('url') ?? '').trim();
    if (!url) return NextResponse.json({ error: 'Paste a stream link' }, { status: 400 });
    normalizeStreamUrl(url);
    const chat = form.get('chat');
    let chatJson: string | undefined;
    if (chat instanceof File && chat.size > 0) {
      if (chat.size > MAX_CHAT_BYTES) return NextResponse.json({ error: 'The chat file is too large' }, { status: 400 });
      chatJson = await chat.text();
    }
    const hunt = await createHunt({
      url,
      creator: String(form.get('creator') ?? '').slice(0, 80),
      maxMoments: Number(form.get('maxMoments') ?? 12) || 12,
      chatJson,
    });
    return NextResponse.json({ id: hunt.id });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
