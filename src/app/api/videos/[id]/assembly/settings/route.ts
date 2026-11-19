import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { END_SCREEN_MAX_SEC, END_SCREEN_MIN_SEC, endScreenSettings } from '@/pipeline/assembly/end-screen';
import { planPacing, tightenFromRetention, DEFAULT_BEAT_PAUSE_SEC, type Section } from '@/pipeline/assembly/pacing';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Assembly settings that sit beside the render settings: the end screen, and pauses tightened
 * from the retention check (with which beats that changes).
 */
async function current(id: string) {
  const { data: video } = await getSupabaseServerClient().from('videos').select('script_json').eq('id', id).maybeSingle();
  if (!video) return null;
  const sj = (video.script_json ?? {}) as Record<string, unknown> & {
    beats?: Array<{ text?: string }>;
    sections?: { sections?: Section[] };
    retention?: { beatsChecked?: number; marks?: never[]; issues?: never[] };
  };
  const beats = Array.isArray(sj.beats) ? sj.beats : [];
  const retention = sj.retention;
  const retentionReady = Boolean(retention?.marks?.length) && retention?.beatsChecked === beats.length;
  const effect = retentionReady
    ? tightenFromRetention(
        planPacing(
          beats.map((b, i) => ({ index: i, text: String(b.text ?? '') })),
          sj.sections?.sections ?? [],
          Number(sj.beat_pause_seconds ?? DEFAULT_BEAT_PAUSE_SEC),
        ),
        retention,
      )
    : null;
  return {
    scriptJson: sj,
    body: {
      endScreen: endScreenSettings(sj.end_screen),
      pacingFromRetention: sj.pacing_from_retention !== false,
      retentionReady,
      tightened: effect?.tightened ?? [],
      loosened: effect?.loosened ?? [],
    },
  };
}

export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!/^[\w-]+$/.test(id)) return NextResponse.json({ error: 'Invalid video' }, { status: 400 });
  const found = await current(id);
  if (!found) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  return NextResponse.json(found.body);
}

const Update = z.object({
  endScreen: z
    .object({
      enabled: z.boolean().optional(),
      seconds: z.number().min(END_SCREEN_MIN_SEC).max(END_SCREEN_MAX_SEC).optional(),
      text: z.string().max(60).optional(),
    })
    .optional(),
  pacingFromRetention: z.boolean().optional(),
});

export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!/^[\w-]+$/.test(id)) return NextResponse.json({ error: 'Invalid video' }, { status: 400 });
  const parsed = Update.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid settings' }, { status: 400 });
  const found = await current(id);
  if (!found) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  const { endScreen, pacingFromRetention } = parsed.data;
  const next = { ...found.scriptJson };
  if (endScreen) next.end_screen = { ...endScreenSettings(found.scriptJson.end_screen), ...endScreen };
  if (pacingFromRetention !== undefined) next.pacing_from_retention = pacingFromRetention;
  const { error } = await getSupabaseServerClient().from('videos').update({ script_json: next }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json((await current(id))!.body);
}
