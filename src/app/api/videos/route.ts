import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { GeneratedScript } from '@/lib/script/generate-script';
import { stylePack } from '@/lib/styles/packs';
import { planShots } from '@/lib/script/shot-planner';
import { trimBrief } from '@/lib/script/outline';
import { createQueuedVideo, resolveNewVideoStyle, styledScript, type ResolvedStyle } from '@/lib/script/new-video';
import { parseSrtToBeats, parseRawTextToParagraphBeats, planVisualsForUploadedBeats } from '@/lib/script/parser';
import { asRankingShort, isRankingSize, rankingMinutes } from '@/lib/script/ranking';
import { ReadyScriptSchema, scriptFromReady } from '@/lib/script/ready-script';
import { scriptMinutes } from '@/lib/script/create-video';

/** The columns the dashboard needs (?summary=1): no scripts, so a long list stays small. */
const SUMMARY_COLUMNS = 'id, title, topic, style, target_minutes, status, error_message, render_url, created_at, updated_at';

export async function GET(req: Request) {
  try {
    const supabase = getSupabaseServerClient();
    const summary = new URL(req.url).searchParams.get('summary') === '1';
    const { data, error } = await supabase
      .from('videos')
      .select(summary ? SUMMARY_COLUMNS : '*')
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

/**
 * Pasted scripts and subtitles skip shot planning (they're meant to be instant), but a stickman
 * video needs its drawing brief before anything can be drawn, so those get one planned here.
 */
async function withDrawingBrief(supabase: SupabaseClient, script: GeneratedScript, topic: string, resolved: ResolvedStyle): Promise<GeneratedScript> {
  const pack = resolved.composed?.pack ?? stylePack(resolved.style);
  return pack?.drawn ? planShots(supabase, script, topic, { style: resolved.style, pack: resolved.composed?.pack }) : script;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      mode = 'ai',
      topic,
      targetMinutes,
      rawText,
      srtText,
      minBeatDurationSeconds,
      brief: rawBrief,
      shortFormat,
    } = body as {
      mode?: 'ai' | 'raw_paragraphs' | 'raw_ai' | 'srt' | 'ready';
      topic?: string;
      targetMinutes?: number | string;
      rawText?: string;
      srtText?: string;
      minBeatDurationSeconds?: number;
      brief?: string;
      /** 'ranking': a vertical countdown Short of its own. */
      shortFormat?: string;
    };

    const supabase = getSupabaseServerClient();
    const resolved = await resolveNewVideoStyle(body);
    const { style } = resolved;
    const ranking = shortFormat === 'ranking';
    const rankingItems = isRankingSize(Number((body as { rankingItems?: unknown }).rankingItems)) ? (Number((body as { rankingItems?: unknown }).rankingItems) as 5 | 10) : 5;

    // -------------------------------------------------------------
    // MODE 0: A FINISHED SCRIPT (beats, visuals, titles; no AI call)
    // -------------------------------------------------------------
    if (mode === 'ready') {
      const parsed = ReadyScriptSchema.safeParse((body as { script?: unknown }).script);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return NextResponse.json({ error: `Invalid script: ${issue?.path.join('.')} ${issue?.message ?? ''}`.trim() }, { status: 400 });
      }
      const script = scriptFromReady(parsed.data);
      const videoTopic = topic?.trim() || script.title_options[0];
      const styled = styledScript(script, resolved);
      const scriptJson = ranking ? asRankingShort(styled, parsed.data.hook_banner) : styled;
      const { data: newVideo, error: insertError } = await supabase
        .from('videos')
        .insert({
          topic: videoTopic,
          style,
          target_minutes: scriptMinutes(script.beats, style, resolved.composed?.pack),
          status: 'script_review',
          script_json: scriptJson,
          title: script.title_options[0],
        })
        .select()
        .single();
      if (insertError || !newVideo) {
        return NextResponse.json({ error: `Failed to create video record: ${insertError?.message}` }, { status: 500 });
      }
      return NextResponse.json(newVideo, { status: 201 });
    }

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
          script_json: styledScript(await withDrawingBrief(supabase, scriptJson, videoTopic, resolved), resolved),
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
      const styled = styledScript(await withDrawingBrief(supabase, scriptJson, videoTopic, resolved), resolved);

      const { data: newVideo, error: insertError } = await supabase
        .from('videos')
        .insert({
          topic: videoTopic,
          style,
          target_minutes: computedMinutes,
          status: 'script_review',
          script_json: ranking ? asRankingShort(styled) : styled,
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
    // MODE 3: RAW TEXT WITH AI SEGMENTATION (in the background)
    // -------------------------------------------------------------
    if (mode === 'raw_ai') {
      if (!rawText || !rawText.trim()) {
        return NextResponse.json({ error: 'Missing required field: rawText' }, { status: 400 });
      }
      const video = await createQueuedVideo(
        supabase,
        // The length comes from the text itself once it's split, not from a form default
        { mode: 'raw_ai', topic: topic?.trim() || 'My Video Script', targetMinutes: 3, rawText, ...(ranking ? { shortFormat: 'ranking' as const } : {}) },
        resolved,
      );
      return NextResponse.json(video, { status: 202 });
    }

    // -------------------------------------------------------------
    // MODE 4: RESEARCH AND WRITE FROM A TOPIC (in the background)
    // -------------------------------------------------------------
    if (!topic?.trim() || targetMinutes === undefined || targetMinutes === null) {
      return NextResponse.json(
        { error: 'Missing required fields for AI mode: topic, targetMinutes' },
        { status: 400 },
      );
    }

    const parsedTargetMinutes = ranking ? rankingMinutes(rankingItems) : parseFloat(String(targetMinutes));
    if (isNaN(parsedTargetMinutes) || parsedTargetMinutes <= 0 || parsedTargetMinutes > 60) {
      return NextResponse.json(
        { error: 'targetMinutes must be between 0.5 and 60' },
        { status: 400 },
      );
    }

    const video = await createQueuedVideo(
      supabase,
      { mode: 'ai', topic: topic.trim(), targetMinutes: parsedTargetMinutes, brief: trimBrief(rawBrief) || null, ...(ranking ? { shortFormat: 'ranking' as const, rankingItems } : {}) },
      resolved,
    );
    return NextResponse.json(video, { status: 202 });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
