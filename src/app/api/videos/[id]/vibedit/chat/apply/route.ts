import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { applyChatPlan, buildEditContext, normalizePlan } from '@/pipeline/vibedit/chat-editor';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const BodySchema = z.object({
  label: z.string().max(1000).optional(),
  changes: z.array(
    z.object({
      beat: z.number().int().min(0),
      shot: z.number().int().min(0),
      action: z.enum(['footage', 'redo', 'text']),
      query: z.string().max(200).nullable().optional(),
      archive: z.boolean().nullable().optional(),
      reason: z.string().max(300).nullable().optional(),
    }),
  ),
});

/** Applies a confirmed plan (snapshotting the beats first); the snapshot id undoes it. */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid changes' }, { status: 400 });
  const supabase = getSupabaseServerClient();
  try {
    // Checked again against the video as it is now
    const plan = normalizePlan({ reply: '', changes: parsed.data.changes }, await buildEditContext(supabase, id));
    if (plan.changes.length === 0) return NextResponse.json({ error: 'None of those shots exist any more' }, { status: 400 });
    return NextResponse.json(await applyChatPlan(supabase, id, plan.changes, parsed.data.label ?? 'Chat edit'));
  } catch (err) {
    console.error('[Vibedit chat] apply failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
