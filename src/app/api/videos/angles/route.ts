import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { suggestAngles } from '@/lib/script/angles';
import { composePack, type StyleSetup } from '@/lib/styles/compose';
import { loadStyleLibrary } from '@/lib/styles/library';

/**
 * "Find angles" on the new-video page. Body: { topic, notes?, setup?, targetMinutes? }.
 * Returns angles to choose from; nothing is created.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { topic?: unknown; notes?: unknown; setup?: Partial<StyleSetup>; targetMinutes?: unknown } | null;
  const topic = typeof body?.topic === 'string' ? body.topic.trim().slice(0, 300) : '';
  if (!topic) return NextResponse.json({ error: 'Type a topic first.' }, { status: 400 });
  try {
    const pack = body?.setup ? composePack(body.setup, await loadStyleLibrary()).pack : null;
    const minutes = Number(body?.targetMinutes);
    const angles = await suggestAngles(getSupabaseServerClient(), {
      topic,
      notes: typeof body?.notes === 'string' ? body.notes : null,
      pack,
      targetMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
    });
    if (!angles.length) return NextResponse.json({ error: 'No usable angles came back; try rewording the topic.' }, { status: 502 });
    return NextResponse.json({ angles });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not find angles' }, { status: 500 });
  }
}
