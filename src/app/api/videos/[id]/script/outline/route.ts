import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { generateOutline, normalizeOutline, BRIEF_SOURCE_ID, type ScriptOutline } from '@/lib/script/outline';
import type { ResearchDossier } from '@/lib/research/types';

async function loadForOutline(id: string) {
  const supabase = getSupabaseServerClient();
  const { data: video } = await supabase.from('videos').select('*').eq('id', id).maybeSingle();
  if (!video) return { supabase, video: null, error: NextResponse.json({ error: 'Video not found.' }, { status: 404 }) };
  if (video.status !== 'script_review') {
    return {
      supabase,
      video: null,
      error: NextResponse.json(
        { error: `Cannot change the outline with status "${video.status}". Expected status "script_review".` },
        { status: 400 },
      ),
    };
  }
  return { supabase, video, error: null };
}

/** Saves the creator's edits to the outline. */
export async function PUT(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const { outline } = (await req.json()) as { outline?: ScriptOutline };
    if (!outline || !Array.isArray(outline.chapters)) {
      return NextResponse.json({ error: 'An outline with chapters is required.' }, { status: 400 });
    }
    const { supabase, video, error } = await loadForOutline(id);
    if (error) return error;
    const sj = video.script_json ?? {};
    const factIds = new Set<string>((sj.research?.facts ?? []).map((f: { id: string }) => f.id));
    const clean = normalizeOutline(
      { hook: String(outline.hook ?? ''), chapters: outline.chapters, closing: String(outline.closing ?? '') },
      factIds,
    );
    const { error: saveError } = await supabase.from('videos').update({ script_json: { ...sj, outline: clean } }).eq('id', id);
    if (saveError) return NextResponse.json({ error: saveError.message }, { status: 500 });
    return NextResponse.json({ outline: clean });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}

/** Drafts the outline again from the brief (optionally with the creator's notes), keeping the research. */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const { notes } = (await req.json().catch(() => ({}))) as { notes?: string };
    const { supabase, video, error } = await loadForOutline(id);
    if (error) return error;
    const sj = video.script_json ?? {};
    if (!sj.brief) return NextResponse.json({ error: 'This video has no brief to outline.' }, { status: 400 });

    // Facts taken from the brief are extracted again, so drop the previous copies
    const research = sj.research as ResearchDossier | undefined;
    const base: ResearchDossier | null =
      research && research.provider !== 'brief'
        ? {
            ...research,
            sources: research.sources.filter((s) => s.id !== BRIEF_SOURCE_ID),
            facts: research.facts.filter((f) => !f.sourceIds.includes(BRIEF_SOURCE_ID)),
          }
        : null;
    const brief = notes?.trim() ? `${sj.brief}\n\nCHANGES WANTED TO THE PREVIOUS OUTLINE:\n${notes.trim()}` : sj.brief;
    const drafted = await generateOutline(supabase, {
      topic: video.topic,
      style: video.style,
      targetMinutes: video.target_minutes,
      brief,
      research: base,
    });

    const { data: latest } = await supabase.from('videos').select('script_json').eq('id', id).single();
    const next = { ...(latest?.script_json ?? sj), outline: drafted.outline, brief_extras: drafted.extras };
    if (drafted.research) next.research = drafted.research;
    else delete next.research;
    const { error: saveError } = await supabase.from('videos').update({ script_json: next }).eq('id', id);
    if (saveError) return NextResponse.json({ error: saveError.message }, { status: 500 });
    return NextResponse.json({ outline: drafted.outline, research: drafted.research });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}
