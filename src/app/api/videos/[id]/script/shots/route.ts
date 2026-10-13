import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { planShots } from '@/lib/script/shot-planner';
import type { GeneratedScript } from '@/lib/script/generate-script';

/**
 * Plans (or re-plans) shots for a video's script.
 * Body: { beatIndexes?: number[] } — omit to plan every beat; pass edited beats to re-plan just those.
 */
export async function handlePlanShots(req: Request, id: string, supabaseClient?: SupabaseClient) {
  const supabase = supabaseClient ?? getSupabaseServerClient();
  const body = (await req.json().catch(() => ({}))) as { beatIndexes?: unknown };
  const beatIndexes = Array.isArray(body.beatIndexes)
    ? body.beatIndexes.filter((n): n is number => Number.isInteger(n))
    : undefined;

  const { data: video, error } = await supabase
    .from('videos')
    .select('id, topic, title, status, script_json')
    .eq('id', id)
    .single();

  if (error || !video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }
  const script = video.script_json as GeneratedScript | null;
  if (!script?.beats?.length) {
    return NextResponse.json({ error: 'Video has no beats to plan shots for' }, { status: 400 });
  }

  const planned = await planShots(supabase, script, video.topic || video.title || 'Video', {
    onlyBeats: beatIndexes,
  });

  const { error: updateError } = await supabase
    .from('videos')
    .update({ script_json: { ...video.script_json, beats: planned.beats } })
    .eq('id', id);
  if (updateError) {
    return NextResponse.json({ error: `Failed to save shot plan: ${updateError.message}` }, { status: 500 });
  }

  return NextResponse.json({ beats: planned.beats });
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params;
    return await handlePlanShots(req, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
