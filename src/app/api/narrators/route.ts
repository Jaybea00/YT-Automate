import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function handleGetNarrators(supabaseClient?: SupabaseClient) {
  try {
    const supabase = supabaseClient ?? getSupabaseServerClient();

    const { data: narrators, error } = await supabase
      .from('narrators')
      .select(`
        id,
        provider_config_id,
        voice_id,
        name,
        sample_url,
        tier,
        created_at,
        provider_slug,
        yt_provider_configs (
          id,
          label,
          provider,
          is_active
        )
      `)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: `Failed to load narrators: ${error.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json(narrators || []);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return handleGetNarrators();
}
