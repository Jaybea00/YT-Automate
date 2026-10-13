import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadEditorContext } from '@/lib/script/editor-context';
import { reviewScript } from '@/lib/script/script-editor';

/**
 * Runs the script doctor and saves the review on the script (script_json.review) so it
 * survives reloads. Body: { beats?: ScriptBeat[] }
 */
export async function handleReviewScript(req: Request, id: string, supabaseClient?: SupabaseClient) {
  const body = (await req.json().catch(() => ({}))) as { beats?: unknown };
  const supabase = supabaseClient ?? getSupabaseServerClient();
  const loaded = await loadEditorContext(supabase, id, body.beats);
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });

  const review = await reviewScript(supabase, loaded.context);

  const { error } = await supabase
    .from('videos')
    .update({ script_json: { ...loaded.script, review } })
    .eq('id', id);
  if (error) {
    return NextResponse.json({ error: `Review ran but could not be saved: ${error.message}`, review }, { status: 500 });
  }
  return NextResponse.json({ review });
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params;
    return await handleReviewScript(req, id);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}
