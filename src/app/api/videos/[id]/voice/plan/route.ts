import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { packForVideo } from '@/lib/styles/compose';
import { applyVoicePlan, changedBeats, describePlan, planVoice } from '@/lib/script/voice-plan';

type BeatVoiceRaw = Record<string, Record<string, unknown>>;

/** GET: the current plan, in words. */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { data: video } = await getSupabaseServerClient().from('videos').select('script_json').eq('id', id).maybeSingle();
  if (!video?.script_json) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  const beatVoice = (video.script_json.beat_voice ?? {}) as BeatVoiceRaw;
  const moods: Record<string, number> = {};
  const speakers = new Set<string>();
  let lines = 0;
  for (const v of Object.values(beatVoice)) {
    if (typeof v.mood === 'string') moods[v.mood] = (moods[v.mood] ?? 0) + 1;
    for (const p of (v.parts as Array<{ speaker?: string }> | undefined) ?? []) {
      lines++;
      if (p.speaker) speakers.add(p.speaker);
    }
  }
  return NextResponse.json({ moods, speakers: [...speakers], lines, beats: video.script_json.beats?.length ?? 0 });
}

/**
 * POST { moods?: boolean, characters?: boolean }: plans the voice again (a mood per beat, voices
 * for quoted characters) and saves it. Returns the beats whose plan changed, to re-voice them.
 */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const body = (await req.json().catch(() => ({}))) as { moods?: boolean; characters?: boolean };
    const supabase = getSupabaseServerClient();
    const { data: video } = await supabase.from('videos').select('style, script_json').eq('id', id).maybeSingle();
    const beats = (video?.script_json?.beats ?? []) as Array<{ text: string }>;
    if (!video || !beats.length) return NextResponse.json({ error: 'There is no script yet.' }, { status: 404 });

    const plan = await planVoice(
      supabase,
      id,
      beats.map((b, index) => ({ index, text: b.text })),
      { moods: body.moods !== false, characters: body.characters !== false, styleLabel: packForVideo(video)?.label },
    );
    if (!plan.moods && !plan.casting) return NextResponse.json({ error: plan.warnings.join(' ') || 'Nothing could be planned' }, { status: 502 });

    // Read again just before saving, so edits made meanwhile aren't lost
    const { data: latest } = await supabase.from('videos').select('script_json').eq('id', id).maybeSingle();
    const before = (latest?.script_json?.beat_voice ?? {}) as BeatVoiceRaw;
    const after = applyVoicePlan(before, plan);
    const { error } = await supabase.from('videos').update({ script_json: { ...latest!.script_json, beat_voice: after } }).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ summary: describePlan(plan.moods, plan.casting), changed: changedBeats(before, after, beats.length), warnings: plan.warnings });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}
