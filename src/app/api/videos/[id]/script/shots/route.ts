import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { planShots } from '@/lib/script/shot-planner';
import type { GeneratedScript } from '@/lib/script/generate-script';

/**
 * Plans (or re-plans) shots for a video's script.
 * Body: { beatIndexes?: number[], drawingBudget?: number } — omit beatIndexes to plan every beat; pass
 * edited beats to re-plan just those. drawingBudget (stickman styles) is saved on the video and
 * sets how many drawings the brief plans.
 */
export async function handlePlanShots(req: Request, id: string, supabaseClient?: SupabaseClient) {
  const supabase = supabaseClient ?? getSupabaseServerClient();
  const body = (await req.json().catch(() => ({}))) as { beatIndexes?: unknown; drawingBudget?: unknown };
  const beatIndexes = Array.isArray(body.beatIndexes)
    ? body.beatIndexes.filter((n): n is number => Number.isInteger(n))
    : undefined;

  const { data: video, error } = await supabase
    .from('videos')
    .select('id, topic, title, style, status, script_json')
    .eq('id', id)
    .single();

  if (error || !video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }
  const script = video.script_json as GeneratedScript | null;
  if (!script?.beats?.length) {
    return NextResponse.json({ error: 'Video has no beats to plan shots for' }, { status: 400 });
  }

  // A new budget replaces the saved one; 0 or null clears it (back to the style's own pace)
  const drawingBudget =
    body.drawingBudget === undefined
      ? (video.script_json?.drawing_budget ?? null)
      : typeof body.drawingBudget === 'number' && body.drawingBudget > 0
        ? Math.min(400, Math.round(body.drawingBudget))
        : null;
  const planned = await planShots(supabase, script, video.topic || video.title || 'Video', {
    onlyBeats: beatIndexes,
    style: video.style,
    illustrations: video.script_json?.illustrations,
    drawingBudget,
  });

  const { error: updateError } = await supabase
    .from('videos')
    .update({ script_json: { ...video.script_json, beats: planned.beats, drawing_budget: drawingBudget } })
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
