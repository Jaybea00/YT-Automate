import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { deriveVoice } from '@/lib/styles/derive-voice';
import { loadStyleLibrary } from '@/lib/styles/library';

/**
 * Describes how the creator writes from scripts they paste. Body: { scripts: string[] }.
 * Returns a draft voice to review and name; nothing is saved until the creator saves it.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { scripts?: unknown } | null;
  try {
    const derived = await deriveVoice(getSupabaseServerClient(), body?.scripts, await loadStyleLibrary());
    return NextResponse.json({ derived });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not derive a voice';
    const status = /Paste at least/.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
