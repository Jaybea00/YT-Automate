import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider } from '@/pipeline/providers/types';
import { stylePack } from '@/lib/styles/packs';
import { withWritingModel, type ScriptBeat } from '@/lib/script/generate-script';
import { planDrawingNotes } from '@/lib/stickman/drawing-notes';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Adds (or redoes) name labels and speech bubbles on a stickman video's drawings, keeping every
 * shot and code as it is, so drawings already uploaded stay where they are. They show once the
 * visuals are rendered again.
 */
export async function POST(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const supabase = getSupabaseServerClient();
  const { data: video } = await supabase.from('videos').select('id, style, script_json').eq('id', id).maybeSingle();
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  if (!stylePack(video.style)?.drawn) return NextResponse.json({ error: 'This is not a stickman video' }, { status: 400 });
  const beats = (video.script_json?.beats ?? []) as ScriptBeat[];
  if (!beats.some((b) => b.shots?.some((s) => s.visual_type === 'drawing'))) {
    return NextResponse.json({ error: 'Plan the drawing brief first' }, { status: 400 });
  }
  try {
    const resolved = await resolveForStage<LLMProvider>('script', supabase);
    const noted = await planDrawingNotes(resolved.provider, withWritingModel(resolved.ctx, resolved.options), beats, video.script_json?.research?.facts ?? []);
    const { error } = await supabase.from('videos').update({ script_json: { ...video.script_json, beats: noted } }).eq('id', id);
    if (error) throw new Error(error.message);
    const shots = noted.flatMap((b) => b.shots ?? []);
    return NextResponse.json({
      beats: noted,
      labels: shots.filter((s) => s.drawing?.label).length,
      bubbles: shots.filter((s) => s.drawing?.bubble).length,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
