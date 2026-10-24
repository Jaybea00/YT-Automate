import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { generateScript } from '@/lib/script/generate-script';
import { planShots } from '@/lib/script/shot-planner';
import { normalizeOutline, type ScriptOutline } from '@/lib/script/outline';
import { afterWriteChecks } from '@/lib/script/after-write';
import { chosenPackage, sanitizePackaging, type Packaging } from '@/lib/script/packaging-types';

/**
 * Brief mode, step 2: writes the full script from the approved outline (sent in the body, as
 * edited on the review page) plus the brief and the saved research.
 */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;

  try {
    const body = (await req.json().catch(() => ({}))) as { outline?: ScriptOutline; packaging?: Packaging };
    const supabase = getSupabaseServerClient();
    const { data: video, error } = await supabase.from('videos').select('*').eq('id', id).single();
    if (error || !video) {
      return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    }
    if (video.status !== 'script_review') {
      return NextResponse.json(
        { error: `Cannot write the script with status "${video.status}". Expected status "script_review".` },
        { status: 400 },
      );
    }

    const sj = video.script_json ?? {};
    const factIds = new Set<string>((sj.research?.facts ?? []).map((f: { id: string }) => f.id));
    const source = body.outline ?? sj.outline;
    if (!source || !Array.isArray(source.chapters)) {
      return NextResponse.json({ error: 'This video has no outline to write from.' }, { status: 400 });
    }
    const outline = normalizeOutline(
      { hook: String(source.hook ?? ''), chapters: source.chapters, closing: String(source.closing ?? '') },
      factIds,
    );
    if (outline.chapters.length === 0) {
      return NextResponse.json({ error: 'The outline needs at least one chapter.' }, { status: 400 });
    }

    // The package the creator picked (and maybe edited) on the outline page
    const packaging = sanitizePackaging(body.packaging ?? sj.packaging);

    // Save the approved outline first, so the creator's edits survive a failed write
    await supabase.from('videos').update({ script_json: { ...sj, outline, ...(packaging ? { packaging } : {}) } }).eq('id', id);

    const written = await generateScript(supabase, {
      topic: video.topic,
      style: video.style,
      targetMinutes: video.target_minutes,
      research: sj.research ?? null,
      brief: sj.brief ?? null,
      outline,
      packaging: chosenPackage(packaging),
    });
    const planned = await planShots(supabase, written, video.topic, { style: video.style, illustrations: video.script_json?.illustrations });
    const checks = await afterWriteChecks(supabase, video.topic, planned, video.style);

    // Re-read so settings changed while the script was being written aren't lost
    const { data: latest } = await supabase.from('videos').select('script_json').eq('id', id).single();
    const { data: updated, error: updateError } = await supabase
      .from('videos')
      .update({ script_json: { ...(latest?.script_json ?? sj), ...planned, outline, ...(packaging ? { packaging } : {}), ...checks } })
      .eq('id', id)
      .select()
      .single();
    if (updateError || !updated) {
      return NextResponse.json({ error: `Failed to save the script: ${updateError?.message}` }, { status: 500 });
    }
    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
