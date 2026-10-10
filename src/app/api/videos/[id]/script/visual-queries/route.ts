import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { enrichBeatsWithAiVisualHints } from '@/lib/script/parser';
import { GeneratedScript } from '@/lib/script/generate-script';

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await props.params;
    const supabase = getSupabaseServerClient();

    const { data: video, error } = await supabase
      .from('videos')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    const currentScript: GeneratedScript | null = video.script_json;
    if (!currentScript || !Array.isArray(currentScript.beats) || currentScript.beats.length === 0) {
      return NextResponse.json(
        { error: 'Video has no beats to generate visual queries for' },
        { status: 400 },
      );
    }

    const enrichedBeats = await enrichBeatsWithAiVisualHints(
      supabase,
      currentScript.beats,
      video.topic || video.title,
    );

    const updatedScript: GeneratedScript = {
      ...currentScript,
      beats: enrichedBeats,
    };

    await supabase
      .from('videos')
      .update({
        script_json: updatedScript,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    return NextResponse.json({ success: true, beats: enrichedBeats }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
