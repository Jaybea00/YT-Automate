import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { keptStyle } from '@/lib/styles/compose';

export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;

  try {
    const supabase = getSupabaseServerClient();
    const { data: video, error } = await supabase
      .from('videos')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !video) {
      return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    }

    return NextResponse.json(video);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;

  try {
    const body = await req.json();
    const supabase = getSupabaseServerClient();

    // Verify video exists
    const { data: existingVideo, error: fetchError } = await supabase
      .from('videos')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !existingVideo) {
      return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    }

    // Allowed fields to patch directly: script_json, title
    const updates: Record<string, unknown> = {};
    if (body.script_json !== undefined) {
      // The style a video was made with (format, niche, snapshot) survives a client that leaves it out
      updates.script_json =
        body.script_json && typeof body.script_json === 'object'
          ? { ...keptStyle(existingVideo.script_json), ...body.script_json }
          : body.script_json;
    }
    if (body.title !== undefined) {
      updates.title = body.title;
    }

    const { data: updatedVideo, error: updateError } = await supabase
      .from('videos')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (updateError || !updatedVideo) {
      return NextResponse.json(
        { error: `Failed to update video: ${updateError?.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json(updatedVideo);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
