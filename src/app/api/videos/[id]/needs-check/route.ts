import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { listNeedsCheck } from '@/pipeline/visuals/rhythm-report';

/** Shots picked while the relevance check was unavailable; the visuals page offers to redo them. */
export async function handleGetNeedsCheck(id: string, supabaseClient?: SupabaseClient) {
  const supabase = supabaseClient ?? getSupabaseServerClient();
  const shots = await listNeedsCheck(supabase, id);
  return NextResponse.json({ shots });
}

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params;
    return await handleGetNeedsCheck(id);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}
