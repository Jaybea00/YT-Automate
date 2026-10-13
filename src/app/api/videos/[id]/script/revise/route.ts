import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { generateScript } from '@/lib/script/generate-script';
import { planShots } from '@/lib/script/shot-planner';

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;

  try {
    const body = await req.json();
    const { feedback } = body as { feedback?: string };

    if (!feedback || !feedback.trim()) {
      return NextResponse.json(
        { error: 'Feedback is required for script revision.' },
        { status: 400 },
      );
    }

    const supabase = getSupabaseServerClient();

    // 1. Load video row
    const { data: video, error } = await supabase
      .from('videos')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !video) {
      return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    }

    if (video.status !== 'script_review') {
      return NextResponse.json(
        {
          error: `Cannot revise script with status "${video.status}". Expected status "script_review".`,
        },
        { status: 400 },
      );
    }

    if (!video.script_json) {
      return NextResponse.json(
        { error: 'No previous script JSON found on video record to revise.' },
        { status: 400 },
      );
    }

    // 2. Call generateScript again with revisionOf
    const rewritten = await generateScript(supabase, {
      topic: video.topic,
      style: video.style,
      targetMinutes: video.target_minutes,
      revisionOf: {
        previousScript: video.script_json,
        feedback: feedback.trim(),
      },
      // Revisions keep writing from the same researched facts
      research: video.script_json.research ?? null,
    });
    const revisedScript = await planShots(supabase, rewritten, video.topic);

    // 3. Update script_json with new result (keeping stored render settings); status stays 'script_review'
    const { data: updatedVideo, error: updateError } = await supabase
      .from('videos')
      .update({
        script_json: { ...video.script_json, ...revisedScript },
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError || !updatedVideo) {
      return NextResponse.json(
        { error: `Failed to update revised script: ${updateError?.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json(updatedVideo);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
