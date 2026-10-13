import { NextResponse } from 'next/server';
import { loadPronunciations, savePronunciations } from '@/pipeline/tts/pronunciations';
import { toSpeakableText } from '@/pipeline/tts/speakable';

/** Channel-wide pronunciation list used when voicing every video. */
export async function GET() {
  return NextResponse.json({ pronunciations: await loadPronunciations() });
}

/** Replaces the list. Body: { pronunciations: [{ term, say }], preview?: string } */
export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { pronunciations?: unknown; preview?: unknown };
    const saved = await savePronunciations(body.pronunciations);
    const preview = typeof body.preview === 'string' ? toSpeakableText(body.preview, saved) : undefined;
    return NextResponse.json({ pronunciations: saved, preview });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to save pronunciations' }, { status: 500 });
  }
}
