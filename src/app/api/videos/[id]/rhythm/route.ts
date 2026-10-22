import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { analyzeRhythm, planToRhythmShots, type RhythmReport } from '@/lib/script/visual-rhythm';
import type { ScriptBeat } from '@/lib/script/generate-script';
import { computeRenderedRhythm } from '@/pipeline/visuals/rhythm-report';
import { stylePack } from '@/lib/styles/packs';

/**
 * Visual rhythm (slideshow risk) for a video: the shot plan's (with the repairs the planner
 * made, when it saved them) and the rendered visuals' (computed now from the shot sidecars, so
 * shot-editor changes count).
 */
export async function handleGetRhythm(id: string, supabaseClient?: SupabaseClient) {
  const supabase = supabaseClient ?? getSupabaseServerClient();
  const { data: video, error } = await supabase.from('videos').select('style, script_json').eq('id', id).maybeSingle();
  if (error || !video) return NextResponse.json({ error: `Video ${id} not found` }, { status: 404 });

  const beats: ScriptBeat[] = Array.isArray(video.script_json?.beats) ? video.script_json.beats : [];
  const saved = video.script_json?.rhythm as { plan?: RhythmReport } | undefined;
  const planned = beats.some((b) => b.shots?.length);
  const plan = saved?.plan ?? (planned ? analyzeRhythm(planToRhythmShots(beats), 'plan', [], stylePack(video.style)?.maxGraphicsShare) : null);
  const render = await computeRenderedRhythm(supabase, id).catch(() => null);
  return NextResponse.json({ plan, render });
}

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params;
    return await handleGetRhythm(id);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}
