import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadPronunciations, savePronunciations } from '@/pipeline/tts/pronunciations';
import { mergeHintsIntoList, suggestPronunciations, type PronunciationHint } from '@/lib/script/pronunciation-hints';

async function saveHints(id: string, hints: PronunciationHint[], checkedAt?: string) {
  const supabase = getSupabaseServerClient();
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', id).maybeSingle();
  if (!video?.script_json) throw new Error('Video not found.');
  const pronunciation_hints = { checkedAt: checkedAt ?? video.script_json.pronunciation_hints?.checkedAt ?? new Date().toISOString(), hints };
  const { error } = await supabase.from('videos').update({ script_json: { ...video.script_json, pronunciation_hints } }).eq('id', id);
  if (error) throw new Error(error.message);
  return pronunciation_hints;
}

/** POST: looks for hard names again, in the beats sent (the page's current text) or the saved ones. */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const body = (await req.json().catch(() => ({}))) as { beats?: Array<{ text?: unknown }> };
    const supabase = getSupabaseServerClient();
    const { data: video } = await supabase.from('videos').select('topic, script_json').eq('id', id).maybeSingle();
    if (!video?.script_json) return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    const sent = Array.isArray(body.beats) ? body.beats.map((b) => b?.text).filter((t): t is string => typeof t === 'string') : [];
    const texts = sent.length ? sent : (video.script_json.beats ?? []).map((b: { text: string }) => b.text);
    if (texts.length === 0) return NextResponse.json({ error: 'There is no script to check yet.' }, { status: 400 });

    const result = await suggestPronunciations(supabase, video.topic ?? '', texts, await loadPronunciations());
    return NextResponse.json({ pronunciation_hints: await saveHints(id, result.hints, result.checkedAt) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * PUT { hints, addNow? }: saves the creator's ticks and respellings. With addNow, the ticked ones
 * join the channel's pronunciation list straight away (otherwise that happens on approval).
 */
export async function PUT(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const body = (await req.json()) as { hints?: unknown; addNow?: boolean };
    if (!Array.isArray(body.hints)) return NextResponse.json({ error: 'hints are required.' }, { status: 400 });
    let hints: PronunciationHint[] = body.hints
      .filter((h) => typeof h?.term === 'string' && typeof h?.say === 'string' && h.term.trim())
      .map((h) => ({
        term: h.term.trim(),
        say: h.say.trim().slice(0, 200),
        ...(typeof h.note === 'string' && h.note.trim() ? { note: h.note.trim() } : {}),
        ...(h.skip ? { skip: true } : {}),
        ...(h.added ? { added: true } : {}),
      }));
    let added = 0;
    if (body.addNow) {
      const merged = mergeHintsIntoList(await loadPronunciations(), hints);
      await savePronunciations(merged.list);
      hints = merged.hints;
      added = merged.added;
    }
    return NextResponse.json({ pronunciation_hints: await saveHints(id, hints), added });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, { status: 500 });
  }
}
