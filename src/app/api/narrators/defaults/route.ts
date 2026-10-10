import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function handleGetDefaults(supabaseClient?: SupabaseClient) {
  try {
    const supabase = supabaseClient ?? getSupabaseServerClient();

    const { data, error } = await supabase
      .from('style_narrator_defaults')
      .select('style, narrator_id');

    if (error) {
      // If table doesn't exist yet (PGRST205 / 42P01), return empty mapping gracefully
      return NextResponse.json({ defaults: {} });
    }

    const defaults: Record<string, string> = {};
    if (Array.isArray(data)) {
      for (const row of data) {
        if (row.style && row.narrator_id) {
          defaults[row.style] = row.narrator_id;
        }
      }
    }

    return NextResponse.json({ defaults });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function handleSetDefaults(
  req: Request,
  supabaseClient?: SupabaseClient,
) {
  try {
    const body = await req.json();
    const supabase = supabaseClient ?? getSupabaseServerClient();

    // Supports either { style, narratorId } or { defaults: Record<string, string | null> }
    const updates: Array<{ style: string; narrator_id: string | null }> = [];

    if (body.style !== undefined) {
      if (typeof body.style !== 'string' || !body.style.trim()) {
        return NextResponse.json({ error: 'Invalid style parameter.' }, { status: 400 });
      }
      updates.push({
        style: body.style.trim(),
        narrator_id: body.narratorId ? String(body.narratorId).trim() : null,
      });
    } else if (body.defaults && typeof body.defaults === 'object') {
      for (const [style, narratorId] of Object.entries(body.defaults)) {
        updates.push({
          style,
          narrator_id: narratorId ? String(narratorId).trim() : null,
        });
      }
    } else {
      return NextResponse.json(
        { error: 'Body must contain "style" and "narratorId", or a "defaults" map.' },
        { status: 400 },
      );
    }

    for (const update of updates) {
      if (!update.narrator_id) {
        await supabase
          .from('style_narrator_defaults')
          .delete()
          .eq('style', update.style);
      } else {
        await supabase
          .from('style_narrator_defaults')
          .upsert(
            {
              style: update.style,
              narrator_id: update.narrator_id,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'style' },
          );
      }
    }

    return NextResponse.json({ success: true, updated: updates });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return handleGetDefaults();
}

export async function POST(req: Request) {
  return handleSetDefaults(req);
}
