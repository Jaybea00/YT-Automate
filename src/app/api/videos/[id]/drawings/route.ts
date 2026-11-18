import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { drawingCode, parseDrawingCode } from '@/lib/stickman/drawing-codes';
import type { ScriptBeat } from '@/lib/script/generate-script';
import { listDrawings, saveDrawing } from '@/pipeline/visuals/drawings-store';
import { loadComposedBeat } from '@/pipeline/visuals/shot-editor';
import { editShot } from '@/pipeline/visuals/shot-editor-actions';
import { packForVideo } from '@/lib/styles/compose';
import { sniffMediaType } from '@/pipeline/utils/media-upload';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MAX_DRAWING_BYTES = 40 * 1024 * 1024;

async function loadDrawnVideo(videoId: string) {
  const supabase = getSupabaseServerClient();
  const { data: video } = await supabase.from('videos').select('id, style, script_json').eq('id', videoId).maybeSingle();
  if (!video) return { supabase, error: NextResponse.json({ error: 'Video not found' }, { status: 404 }) };
  if (!packForVideo(video)?.drawn) return { supabase, error: NextResponse.json({ error: 'This is not a stickman video' }, { status: 400 }) };
  return { supabase, video, beats: (video.script_json?.beats ?? []) as ScriptBeat[] };
}

/** The codes of every drawing shot in the plan, and which of them have a drawing filed. */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const loaded = await loadDrawnVideo(id);
  if (loaded.error) return loaded.error;
  const filed = await listDrawings(id);
  const codes = loaded.beats.flatMap((b) => (b.shots ?? []).map((s, i) => (s.visual_type === 'drawing' ? drawingCode(b.index, i) : null)).filter((c): c is string => Boolean(c)));
  return NextResponse.json({ codes, filed: codes.filter((c) => filed.has(c)) });
}

/** Stickman settings. Body: { bibleTranslation: "webbe" | "web" } (verse cards rendered after the change). */
export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const loaded = await loadDrawnVideo(id);
  if (loaded.error) return loaded.error;
  const body = (await req.json().catch(() => ({}))) as { bibleTranslation?: unknown };
  if (body.bibleTranslation !== 'webbe' && body.bibleTranslation !== 'web') {
    return NextResponse.json({ error: 'bibleTranslation must be "webbe" or "web"' }, { status: 400 });
  }
  const { error } = await loaded.supabase
    .from('videos')
    .update({ script_json: { ...loaded.video.script_json, bible_translation: body.bibleTranslation } })
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ bibleTranslation: body.bibleTranslation });
}

/**
 * One drawing, named with its code ("B05_S2.png"): filed for that shot and, when the beat has
 * already been rendered, put into the video straight away. Form fields: file, and optionally code
 * (when the file name doesn't carry it).
 */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const loaded = await loadDrawnVideo(id);
  if (loaded.error) return loaded.error;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Send the drawing as multipart form data' }, { status: 400 });
  }
  const file = form.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'Missing field: file' }, { status: 400 });
  if (file.size > MAX_DRAWING_BYTES) return NextResponse.json({ error: 'Drawings must be under 40 MB' }, { status: 400 });
  const code = parseDrawingCode(String(form.get('code') || '') || file.name);
  if (!code) return NextResponse.json({ error: `${file.name}: no drawing code in the name (name it like B05_S2.png)` }, { status: 400 });
  const label = drawingCode(code.beat_index, code.shot_index);
  const planned = loaded.beats.find((b) => b.index === code.beat_index)?.shots?.[code.shot_index];
  if (planned?.visual_type !== 'drawing') return NextResponse.json({ error: `${file.name}: ${label} is not a drawing in this video's brief` }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffMediaType(buffer);
  if (!sniffed || sniffed.isVideo) return NextResponse.json({ error: `${file.name}: drawings must be PNG, JPG or WebP` }, { status: 400 });
  const temp = path.join(/* turbopackIgnore: true */ os.tmpdir(), `drawing-${Date.now()}-${Math.random().toString(36).slice(2)}.${sniffed.ext}`);
  await fsp.writeFile(temp, buffer);
  try {
    const beat = await loadComposedBeat(loaded.supabase, id, code.beat_index);
    if (beat?.shots[code.shot_index]) {
      // Files the drawing and renders it into the beat
      await editShot({ supabase: loaded.supabase, videoId: id, beat, shotIndex: code.shot_index, edit: { action: 'upload', filePath: temp, mediaType: 'image', license: 'own_work' } });
      return NextResponse.json({ code: label, placed: true });
    }
    await saveDrawing(id, code.beat_index, code.shot_index, temp);
    return NextResponse.json({ code: label, placed: false });
  } catch (err) {
    console.error(`[Drawings] ${label} failed:`, err);
    return NextResponse.json({ error: `${label}: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  } finally {
    await fsp.unlink(temp).catch(() => {});
  }
}
