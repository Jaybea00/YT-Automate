import { NextResponse } from 'next/server';
import { packForVideo } from '@/lib/styles/compose';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { chosenPackage } from '@/lib/script/packaging-types';
import { retentionCheckScript, type RetentionReport } from '@/lib/script/retention';
import type { ScriptBeat } from '@/lib/script/generate-script';

/**
 * POST: runs the retention check on the beats sent (the page's current text) or the saved ones.
 * The report is saved with the script.
 */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const body = (await req.json().catch(() => ({}))) as { beats?: ScriptBeat[] };
    const supabase = getSupabaseServerClient();
    const { data: video } = await supabase.from('videos').select('style, script_json').eq('id', id).maybeSingle();
    if (!video?.script_json) return NextResponse.json({ error: 'Video not found.' }, { status: 404 });

    const sent = Array.isArray(body.beats) ? body.beats.filter((b) => typeof b?.index === 'number' && typeof b?.text === 'string') : null;
    const beats: ScriptBeat[] = sent?.length ? sent : (video.script_json.beats ?? []);
    if (beats.length === 0) return NextResponse.json({ error: 'There is no script to check yet.' }, { status: 400 });

    const report = await retentionCheckScript(supabase, beats, {
      title: video.script_json.title_options?.[0],
      packaging: chosenPackage(video.script_json.packaging),
      pack: packForVideo(video),
    });
    const { data: latest } = await supabase.from('videos').select('script_json').eq('id', id).maybeSingle();
    const { error } = await supabase
      .from('videos')
      .update({ script_json: { ...(latest?.script_json ?? video.script_json), retention: report } })
      .eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ report });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}

/** PATCH { issueId, dismissed }: the creator keeps the beat as it is. */
export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const { issueId, dismissed } = (await req.json()) as { issueId?: string; dismissed?: boolean };
    if (!issueId) return NextResponse.json({ error: 'issueId is required.' }, { status: 400 });
    const supabase = getSupabaseServerClient();
    const { data: video } = await supabase.from('videos').select('script_json').eq('id', id).maybeSingle();
    const report = video?.script_json?.retention as RetentionReport | undefined;
    if (!report?.issues.some((i) => i.id === issueId)) return NextResponse.json({ error: 'Issue not found.' }, { status: 404 });
    const next: RetentionReport = { ...report, issues: report.issues.map((i) => (i.id === issueId ? { ...i, dismissed: dismissed !== false } : i)) };
    const { error } = await supabase.from('videos').update({ script_json: { ...video!.script_json, retention: next } }).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ report: next });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}
