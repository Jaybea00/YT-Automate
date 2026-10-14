import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadVideo, publishView, saveEdits } from '@/pipeline/publish/publish-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Everything the publish page shows. */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const supabase = getSupabaseServerClient();
  const video = await loadVideo(supabase, id);
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  return NextResponse.json(await publishView(supabase, video));
}

const EditsSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(60).optional(),
});

/** Saves the user's edits to the title, description and tags. */
export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const edits = EditsSchema.safeParse(await req.json().catch(() => null));
  if (!edits.success) return NextResponse.json({ error: 'Invalid edits (title up to 100 characters, description up to 5,000)' }, { status: 400 });
  const supabase = getSupabaseServerClient();
  const video = await loadVideo(supabase, id);
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  await saveEdits(supabase, id, edits.data);
  return NextResponse.json(await publishView(supabase, (await loadVideo(supabase, id))!));
}
