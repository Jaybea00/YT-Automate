import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadPronunciations, savePronunciations } from '@/pipeline/tts/pronunciations';
import { mergeHintsIntoList, type PronunciationHints } from '@/lib/script/pronunciation-hints';

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;

  try {
    const body = await req.json();
    const { selectedTitle } = body as { selectedTitle?: string };

    if (!selectedTitle || !selectedTitle.trim()) {
      return NextResponse.json(
        { error: 'selectedTitle is required to approve the script.' },
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
          error: `Cannot approve script with status "${video.status}". Expected status "script_review".`,
        },
        { status: 400 },
      );
    }

    // Brief mode: an outline isn't a script yet
    if (!Array.isArray(video.script_json?.beats) || video.script_json.beats.length === 0) {
      return NextResponse.json(
        { error: 'There is no script to approve yet. Write the full script from the outline first.' },
        { status: 400 },
      );
    }

    // 2. Validate selectedTitle is in script_json.title_options
    const titleOptions: string[] = video.script_json?.title_options ?? [];
    if (!titleOptions.includes(selectedTitle.trim())) {
      return NextResponse.json(
        {
          error: `Selected title "${selectedTitle.trim()}" is not one of the available title options.`,
        },
        { status: 400 },
      );
    }

    // Ticked pronunciation hints join the channel's list now, before voicing reads it
    let scriptJson = video.script_json;
    const hints = video.script_json.pronunciation_hints as PronunciationHints | undefined;
    if (hints?.hints.some((h) => !h.skip && !h.added)) {
      try {
        const merged = mergeHintsIntoList(await loadPronunciations(), hints.hints);
        await savePronunciations(merged.list);
        scriptJson = { ...scriptJson, pronunciation_hints: { ...hints, hints: merged.hints } };
        console.log(`[approve] Added ${merged.added} pronunciation(s) to the channel list`);
      } catch (err) {
        console.warn('[approve] Could not add pronunciation hints; voicing without them:', err);
      }
    }

    // 3. Set script_approved_at = now(), title = selectedTitle, status = 'voicing'
    const { data: updatedVideo, error: updateError } = await supabase
      .from('videos')
      .update({
        script_json: scriptJson,
        title: selectedTitle.trim(),
        script_approved_at: new Date().toISOString(),
        status: 'voicing',
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError || !updatedVideo) {
      return NextResponse.json(
        { error: `Failed to approve script: ${updateError?.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json(updatedVideo);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
