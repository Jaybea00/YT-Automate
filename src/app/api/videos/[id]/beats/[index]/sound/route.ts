import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { normalizeBeatSound } from '@/pipeline/assembly/beat-sound';

interface RouteContext {
  params: Promise<{ id: string; index: string }>;
}

/**
 * { music?, muteSfx?, pauseAfterSec? }: this beat's sound controls (music level, muted effects,
 * a dramatic pause after the line). An empty body resets them. Heard on the next render or preview.
 */
export async function PUT(req: Request, context: RouteContext) {
  const { id, index } = await context.params;
  const beatIndex = Number.parseInt(index, 10);
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isInteger(beatIndex) || beatIndex < 0) {
    return NextResponse.json({ error: 'Invalid video or beat' }, { status: 400 });
  }
  const supabase = getSupabaseServerClient();
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', id).maybeSingle();
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  const sj = (video.script_json ?? {}) as Record<string, unknown> & { beats?: unknown[]; beat_sound?: Record<string, unknown> };
  if (!Array.isArray(sj.beats) || !sj.beats[beatIndex]) return NextResponse.json({ error: `Beat ${beatIndex + 1} does not exist` }, { status: 400 });

  const control = normalizeBeatSound(await req.json().catch(() => null));
  const beatSound = { ...(sj.beat_sound ?? {}) };
  if (control) beatSound[beatIndex] = control;
  else delete beatSound[beatIndex];
  await supabase.from('videos').update({ script_json: { ...sj, beat_sound: beatSound } }).eq('id', id);
  return NextResponse.json({ sound: control });
}
