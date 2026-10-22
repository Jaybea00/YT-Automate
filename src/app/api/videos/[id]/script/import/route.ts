import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import {
  parseSrtToBeats,
  parseRawTextToParagraphBeats,
  parseRawTextWithAi,
  planVisualsForUploadedBeats,
} from '@/lib/script/parser';
import { GeneratedScript } from '@/lib/script/generate-script';
import { planShots } from '@/lib/script/shot-planner';

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await props.params;
    const body = await req.json();
    const {
      mode = 'raw_paragraphs',
      rawText,
      srtText,
      minBeatDurationSeconds,
    } = body as {
      mode: 'raw_paragraphs' | 'raw_ai' | 'srt';
      rawText?: string;
      srtText?: string;
      minBeatDurationSeconds?: number;
    };

    const supabase = getSupabaseServerClient();

    // 1. Fetch current video
    const { data: video, error: videoError } = await supabase
      .from('videos')
      .select('*')
      .eq('id', id)
      .single();

    if (videoError || !video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    let newScript: GeneratedScript;

    if (mode === 'srt') {
      if (!srtText || !srtText.trim()) {
        return NextResponse.json({ error: 'Missing required field: srtText' }, { status: 400 });
      }
      const beats = parseSrtToBeats(srtText, {
        minBeatDurationSeconds: minBeatDurationSeconds !== undefined ? Number(minBeatDurationSeconds) : 4.0,
      });
      if (beats.length === 0) {
        return NextResponse.json({ error: 'No cues found in provided SRT text' }, { status: 400 });
      }
      newScript = {
        title_options: video.script_json?.title_options || [video.title || 'My Video'],
        beats: await planVisualsForUploadedBeats(supabase, beats, video.topic || video.title),
      };
    } else if (mode === 'raw_ai') {
      if (!rawText || !rawText.trim()) {
        return NextResponse.json({ error: 'Missing required field: rawText' }, { status: 400 });
      }
      const segmented = await parseRawTextWithAi(supabase, rawText, {
        topic: video.topic,
        style: video.style,
      });
      newScript = await planShots(supabase, segmented, video.topic || video.title, { style: video.style });
    } else {
      // mode === 'raw_paragraphs'
      if (!rawText || !rawText.trim()) {
        return NextResponse.json({ error: 'Missing required field: rawText' }, { status: 400 });
      }
      const beats = parseRawTextToParagraphBeats(rawText);
      if (beats.length === 0) {
        return NextResponse.json({ error: 'No paragraphs found in provided text' }, { status: 400 });
      }
      newScript = {
        title_options: video.script_json?.title_options || [video.title || 'My Video'],
        beats: await planVisualsForUploadedBeats(supabase, beats, video.topic || video.title),
      };
    }

    // Update database
    const { data: updatedVideo, error: updateError } = await supabase
      .from('videos')
      .update({
        script_json: newScript,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json(
        { error: `Failed to save imported script: ${updateError.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { success: true, video: updatedVideo, script: newScript },
      { status: 200 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
