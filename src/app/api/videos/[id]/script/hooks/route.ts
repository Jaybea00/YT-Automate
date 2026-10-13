import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadEditorContext } from '@/lib/script/editor-context';
import { generateHooks } from '@/lib/script/script-editor';

/** Returns alternative opening hooks, one per technique. Body: { beats?: ScriptBeat[] } */
export async function handleGenerateHooks(req: Request, id: string, supabaseClient?: SupabaseClient) {
  const body = (await req.json().catch(() => ({}))) as { beats?: unknown };
  const supabase = supabaseClient ?? getSupabaseServerClient();
  const loaded = await loadEditorContext(supabase, id, body.beats);
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });

  const hooks = await generateHooks(supabase, loaded.context);
  return NextResponse.json({ hooks });
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params;
    return await handleGenerateHooks(req, id);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}
