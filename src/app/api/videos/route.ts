import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { generateScript, GeneratedScript } from '@/lib/script/generate-script';
import { VideoStyle } from '@/lib/script/style-templates';
import { withStyleDefaults } from '@/lib/styles/packs';
import { researchTopic } from '@/lib/research/research';
import { planShots } from '@/lib/script/shot-planner';
import {
  parseSrtToBeats,
  parseRawTextToParagraphBeats,
  parseRawTextWithAi,
  planVisualsForUploadedBeats,
} from '@/lib/script/parser';

export async function GET() {
  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from('videos')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data || []);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      mode = 'ai',
      topic,
      style = 'tech',
      targetMinutes,
      rawText,
      srtText,
      minBeatDurationSeconds,
    } = body as {
      mode?: 'ai' | 'raw_paragraphs' | 'raw_ai' | 'srt';
      topic?: string;
      style?: VideoStyle;
      targetMinutes?: number | string;
      rawText?: string;
      srtText?: string;
      minBeatDurationSeconds?: number;
    };

    const supabase = getSupabaseServerClient();

    // -------------------------------------------------------------
    // MODE 1: SRT SUBTITLES
    // -------------------------------------------------------------
    if (mode === 'srt') {
      if (!srtText || !srtText.trim()) {
        return NextResponse.json({ error: 'Missing required field: srtText' }, { status: 400 });
      }

      const parsedBeats = parseSrtToBeats(srtText, {
        minBeatDurationSeconds: minBeatDurationSeconds !== undefined ? Number(minBeatDurationSeconds) : 4.0,
      });

      if (parsedBeats.length === 0) {
        return NextResponse.json(
          { error: 'Could not extract any subtitle cues from the provided SRT content.' },
          { status: 400 },
        );
      }

      const videoTopic = topic?.trim() || parsedBeats[0]?.text.slice(0, 50) || 'Uploaded Subtitles Video';
      const beats = await planVisualsForUploadedBeats(supabase, parsedBeats, videoTopic);
      const totalSeconds = beats.reduce((acc, b) => acc + (b.duration_estimate_seconds || 0), 0);
      const computedMinutes = Math.max(0.5, Math.round((totalSeconds / 60) * 10) / 10);

      const scriptJson: GeneratedScript = {
        title_options: [videoTopic, `${videoTopic} (SRT)`, `Video: ${videoTopic}`],
        beats,
      };

      const { data: newVideo, error: insertError } = await supabase
        .from('videos')
        .insert({
          topic: videoTopic,
          style,
          target_minutes: computedMinutes,
          status: 'script_review',
          script_json: withStyleDefaults(scriptJson, style),
          title: videoTopic,
        })
        .select()
        .single();

      if (insertError || !newVideo) {
        return NextResponse.json(
          { error: `Failed to create video record: ${insertError?.message}` },
          { status: 500 },
        );
      }

      return NextResponse.json(newVideo, { status: 201 });
    }

    // -------------------------------------------------------------
    // MODE 2: RAW TEXT PARAGRAPHS (Zero LLM, Instant)
    // -------------------------------------------------------------
    if (mode === 'raw_paragraphs') {
      if (!rawText || !rawText.trim()) {
        return NextResponse.json({ error: 'Missing required field: rawText' }, { status: 400 });
      }

      const parsedBeats = parseRawTextToParagraphBeats(rawText);
      if (parsedBeats.length === 0) {
        return NextResponse.json(
          { error: 'No valid paragraphs found in provided text.' },
          { status: 400 },
        );
      }

      const videoTopic = topic?.trim() || parsedBeats[0]?.text.slice(0, 50) || 'Manual Script Video';
      const beats = await planVisualsForUploadedBeats(supabase, parsedBeats, videoTopic);
      const totalSeconds = beats.reduce((acc, b) => acc + (b.duration_estimate_seconds || 0), 0);
      const computedMinutes = Math.max(0.5, Math.round((totalSeconds / 60) * 10) / 10);

      const scriptJson: GeneratedScript = {
        title_options: [videoTopic, `${videoTopic} (Manual)`, `Guide: ${videoTopic}`],
        beats,
      };

      const { data: newVideo, error: insertError } = await supabase
        .from('videos')
        .insert({
          topic: videoTopic,
          style,
          target_minutes: computedMinutes,
          status: 'script_review',
          script_json: withStyleDefaults(scriptJson, style),
          title: videoTopic,
        })
        .select()
        .single();

      if (insertError || !newVideo) {
        return NextResponse.json(
          { error: `Failed to create video record: ${insertError?.message}` },
          { status: 500 },
        );
      }

      return NextResponse.json(newVideo, { status: 201 });
    }

    // -------------------------------------------------------------
    // MODE 3: RAW TEXT WITH AI SEGMENTATION
    // -------------------------------------------------------------
    if (mode === 'raw_ai') {
      if (!rawText || !rawText.trim()) {
        return NextResponse.json({ error: 'Missing required field: rawText' }, { status: 400 });
      }

      const videoTopic = topic?.trim() || 'My Video Script';

      // 1. Create row with status scripting
      const { data: newVideo, error: insertError } = await supabase
        .from('videos')
        .insert({
          topic: videoTopic,
          style,
          target_minutes: targetMinutes ? parseFloat(String(targetMinutes)) : 3,
          status: 'scripting',
        })
        .select()
        .single();

      if (insertError || !newVideo) {
        return NextResponse.json(
          { error: `Failed to create video record: ${insertError?.message}` },
          { status: 500 },
        );
      }

      try {
        const segmented = await parseRawTextWithAi(supabase, rawText, {
          topic: videoTopic,
          style,
        });
        const generatedScript = await planShots(supabase, segmented, videoTopic, { style });

        const { data: updatedVideo, error: updateError } = await supabase
          .from('videos')
          .update({
            script_json: withStyleDefaults(generatedScript, style),
            status: 'script_review',
            title: generatedScript.title_options[0] || videoTopic,
          })
          .eq('id', newVideo.id)
          .select()
          .single();

        if (updateError || !updatedVideo) {
          throw new Error(`Failed to update video: ${updateError?.message}`);
        }

        return NextResponse.json(updatedVideo, { status: 201 });
      } catch (genErr) {
        await supabase
          .from('videos')
          .update({
            status: 'failed',
            error_message: genErr instanceof Error ? genErr.message : String(genErr),
          })
          .eq('id', newVideo.id);

        return NextResponse.json(
          { error: `AI text segmentation failed: ${genErr instanceof Error ? genErr.message : String(genErr)}` },
          { status: 500 },
        );
      }
    }

    // -------------------------------------------------------------
    // MODE 4: FULL AI PROMPT (Standard existing workflow)
    // -------------------------------------------------------------
    if (!topic || !style || targetMinutes === undefined || targetMinutes === null) {
      return NextResponse.json(
        { error: 'Missing required fields for AI mode: topic, style, targetMinutes' },
        { status: 400 },
      );
    }

    const parsedTargetMinutes = parseFloat(String(targetMinutes));
    if (isNaN(parsedTargetMinutes) || parsedTargetMinutes <= 0) {
      return NextResponse.json(
        { error: 'targetMinutes must be a positive number' },
        { status: 400 },
      );
    }

    // 1. Insert row with status='scripting'
    const { data: newVideo, error: insertError } = await supabase
      .from('videos')
      .insert({
        topic: topic.trim(),
        style,
        target_minutes: parsedTargetMinutes,
        status: 'scripting',
      })
      .select()
      .single();

    if (insertError || !newVideo) {
      return NextResponse.json(
        { error: `Failed to create video record: ${insertError?.message}` },
        { status: 500 },
      );
    }

    // 2. Research the topic, then write the script from the researched facts
    try {
      const research = await researchTopic(supabase, topic.trim());
      const writtenScript = await generateScript(supabase, {
        topic: topic.trim(),
        style,
        targetMinutes: parsedTargetMinutes,
        research,
      });
      const generatedScript = await planShots(supabase, writtenScript, topic.trim(), { style });

      // 3. Update with script_json and status='script_review'
      const { data: updatedVideo, error: updateError } = await supabase
        .from('videos')
        .update({
          script_json: withStyleDefaults(generatedScript, style),
          status: 'script_review',
        })
        .eq('id', newVideo.id)
        .select()
        .single();

      if (updateError || !updatedVideo) {
        throw new Error(
          `Failed to update video with generated script: ${updateError?.message}`,
        );
      }

      return NextResponse.json(updatedVideo, { status: 201 });
    } catch (genError) {
      const errorMsg =
        genError instanceof Error ? genError.message : String(genError);

      await supabase
        .from('videos')
        .update({
          status: 'failed',
          error_message: errorMsg,
        })
        .eq('id', newVideo.id);

      return NextResponse.json(
        { error: `Script generation failed: ${errorMsg}` },
        { status: 500 },
      );
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
