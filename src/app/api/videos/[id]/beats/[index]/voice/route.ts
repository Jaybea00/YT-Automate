import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { saveBeatVoice } from '@/pipeline/tts/beat-voice-store';
import { handleRegenTts } from '../regen-tts/route';

interface RouteContext {
  params: Promise<{ id: string; index: string }>;
}

/**
 * { speed?, narratorId?, removeRecording? }: this beat's voice settings (null resets one), then
 * the beat is voiced again with them.
 */
export async function PUT(req: Request, context: RouteContext) {
  const { id, index } = await context.params;
  const beatIndex = Number.parseInt(index, 10);
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isInteger(beatIndex) || beatIndex < 0) {
    return NextResponse.json({ error: 'Invalid video or beat' }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as { speed?: unknown; narratorId?: unknown; removeRecording?: unknown };
  const supabase = getSupabaseServerClient();
  try {
    const voice = await saveBeatVoice(supabase, id, beatIndex, {
      speed: body.speed === null ? null : typeof body.speed === 'number' ? body.speed : undefined,
      narratorId: body.narratorId === null || body.narratorId === '' ? null : typeof body.narratorId === 'string' ? body.narratorId : undefined,
      recorded: body.removeRecording === true ? null : undefined,
    });
    const voiced = await handleRegenTts(new Request(req.url, { method: 'POST', body: '{}' }), id, String(beatIndex), supabase);
    const result = await voiced.json();
    if (!voiced.ok) return NextResponse.json({ error: result.error, voice }, { status: voiced.status });
    return NextResponse.json({ voice, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
