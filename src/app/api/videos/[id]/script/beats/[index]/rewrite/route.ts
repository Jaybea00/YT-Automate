import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadEditorContext } from '@/lib/script/editor-context';
import { rewriteBeat } from '@/lib/script/script-editor';

/**
 * Returns 3 rewritten variants of one beat (nothing is saved; the page applies the chosen one).
 * Body: { instruction?: string, beats?: ScriptBeat[] }
 */
export async function handleRewriteBeat(
  req: Request,
  id: string,
  indexStr: string,
  supabaseClient?: SupabaseClient,
) {
  const index = Number.parseInt(indexStr, 10);
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: 'Invalid beat index' }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as { instruction?: unknown; beats?: unknown };
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 500) : '';

  const supabase = supabaseClient ?? getSupabaseServerClient();
  const loaded = await loadEditorContext(supabase, id, body.beats);
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  if (!loaded.context.beats[index]) {
    return NextResponse.json({ error: `Beat ${index} does not exist` }, { status: 400 });
  }

  const variants = await rewriteBeat(supabase, loaded.context, index, instruction);
  return NextResponse.json({ variants });
}

export async function POST(req: Request, props: { params: Promise<{ id: string; index: string }> }) {
  try {
    const { id, index } = await props.params;
    return await handleRewriteBeat(req, id, index);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}
