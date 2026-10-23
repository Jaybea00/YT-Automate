import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { planChatEdit } from '@/pipeline/vibedit/chat-editor';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** { message, history? }: the shot changes the request means, for the creator to confirm. Nothing is changed. */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { message?: unknown; history?: unknown };
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return NextResponse.json({ error: 'Say what to change' }, { status: 400 });
  const history = Array.isArray(body.history)
    ? body.history
        .filter((h): h is { role: 'user' | 'assistant'; text: string } => (h?.role === 'user' || h?.role === 'assistant') && typeof h?.text === 'string')
        .map((h) => ({ role: h.role, text: h.text.slice(0, 600) }))
    : [];
  try {
    return NextResponse.json(await planChatEdit(getSupabaseServerClient(), id, message, history));
  } catch (err) {
    console.error('[Vibedit chat] planning failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
