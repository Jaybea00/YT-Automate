import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import {
  generateYouTubeChapters,
  formatTimestamp,
  parseChaptersText,
  type ScriptBeatLike,
  type UnitTimingLike,
} from '@/pipeline/utils/chapters';
import { DEFAULT_BEAT_PAUSE_SEC, planPacing } from '@/pipeline/assembly/pacing';
import type { SavedSections } from '@/pipeline/assembly/sections';
import { buildDescriptionCredits } from '@/pipeline/utils/credits';

/**
 * Chapters for a script: by section when sections are planned, timed with the pauses between
 * beats included (the same pacing assembly uses).
 */
function chaptersFor(
  scriptJson: { sections?: SavedSections; beat_pause_seconds?: number } | null | undefined,
  beats: ScriptBeatLike[],
  units: UnitTimingLike[],
  customTitles: Record<number, string>,
  formatStyle: 'dash' | 'space' = 'dash',
) {
  const sections = scriptJson?.sections?.sections;
  const pacing = sections?.length
    ? planPacing(beats.map((b) => ({ index: b.index, text: b.text ?? '' })), sections, Number(scriptJson?.beat_pause_seconds ?? DEFAULT_BEAT_PAUSE_SEC))
    : null;
  const gapMs = pacing
    ? Object.fromEntries([...pacing].map(([i, p]) => [i, Math.round((p.leadInSec + p.tailSec) * 1000)]))
    : undefined;
  return generateYouTubeChapters({ beats, units, customTitles, formatStyle, sections, gapMs });
}

export async function handleGetChapters(
  req: Request,
  id: string,
  supabaseClient?: SupabaseClient,
) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();

  // 1. Fetch video
  const { data: video, error: videoError } = await supabase
    .from('videos')
    .select('id, title, topic, status, script_json')
    .eq('id', id)
    .maybeSingle();

  if (videoError || !video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const url = new URL(req.url, 'http://localhost');
  const formatStyle = (url.searchParams.get('style') === 'space' ? 'space' : 'dash') as 'dash' | 'space';

  // 2. Extract beats from script_json
  const beats: ScriptBeatLike[] =
    video.script_json?.beats ||
    video.script_json?.scenes?.map((s: { scene_number: number; narration?: string; visual_prompt?: string; duration_estimate_seconds?: number }) => ({
      index: s.scene_number,
      text: s.narration,
      visual_query: s.visual_prompt,
      duration_estimate_seconds: s.duration_estimate_seconds,
    })) ||
    [];

  // 3. Fetch latest job and its units
  const { data: latestJob } = await supabase
    .from('yt_jobs')
    .select('id, status')
    .eq('video_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let units: UnitTimingLike[] = [];
  if (latestJob?.id) {
    const { data: jobUnits } = await supabase
      .from('yt_job_units')
      .select('unit_index, duration_ms, stage, status')
      .eq('job_id', latestJob.id)
      .in('stage', ['tts', 'assembly']);

    if (jobUnits) {
      // Prefer tts duration_ms, assembly duration_ms as second source
      units = jobUnits;
    }
  }

  const customTitles = (video.script_json?.custom_chapters || {}) as Record<number, string>;
  const chapterResult = chaptersFor(video.script_json, beats, units, customTitles, formatStyle);

  // Credits the description must carry (music, and visuals whose licence requires attribution).
  // An extra: failing to load them never breaks the chapters
  let creditsText = '';
  try {
    const { data: assets } = await supabase.from('video_assets').select('license_type, attribution_text').eq('video_id', id);
    creditsText = buildDescriptionCredits(
      Array.isArray(video.script_json?.music_credits) ? video.script_json.music_credits : [],
      assets ?? [],
    );
  } catch (err) {
    console.warn('[Chapters] Could not load credits:', err);
  }

  return NextResponse.json({
    videoId: id,
    videoTitle: video.title,
    chapters: chapterResult.chapters,
    formattedText: chapterResult.formattedText,
    totalDurationSeconds: chapterResult.totalDurationSeconds,
    totalDurationFormatted: formatTimestamp(chapterResult.totalDurationSeconds),
    hasMeasuredDurations: chapterResult.hasMeasuredDurations,
    customTitles,
    creditsText,
  });
}

export async function handlePostChapters(
  req: Request,
  id: string,
  supabaseClient?: SupabaseClient,
) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();

  const { data: video, error: videoError } = await supabase
    .from('videos')
    .select('id, script_json')
    .eq('id', id)
    .maybeSingle();

  if (videoError || !video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const newCustomTitles: Record<number, string> = {};
  // Pasted chapter lines are in chapter order; titles are stored by each chapter's first beat
  const currentChapters = chaptersFor(video.script_json, video.script_json?.beats ?? [], [], {}).chapters;

  if (body.customTitles && typeof body.customTitles === 'object') {
    for (const [k, v] of Object.entries(body.customTitles)) {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && typeof v === 'string') {
        newCustomTitles[idx] = v.trim();
      }
    }
  } else if (typeof body.rawText === 'string') {
    // Parse from pasted text format
    const parsed = parseChaptersText(body.rawText);
    parsed.forEach((item, idx) => {
      newCustomTitles[currentChapters[idx]?.beatIndex ?? idx] = item.title;
    });
  }

  const updatedScriptJson = {
    ...(video.script_json || {}),
    custom_chapters: newCustomTitles,
  };

  const { error: updateError } = await supabase
    .from('videos')
    .update({
      script_json: updatedScriptJson,
    })
    .eq('id', id);

  if (updateError) {
    return NextResponse.json(
      { error: `Failed to update chapters: ${updateError.message}` },
      { status: 500 },
    );
  }

  // Return fresh chapter result
  return handleGetChapters(req, id, supabase);
}

export async function GET(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;
  return handleGetChapters(req, id);
}

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;
  return handlePostChapters(req, id);
}
