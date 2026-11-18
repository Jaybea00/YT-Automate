import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { trimBrief } from '@/lib/script/outline';
import { createQueuedVideo, resolveNewVideoStyle } from '@/lib/script/new-video';

const MAX_BATCH_TOPICS = 10;

/** Topics from a body value: trimmed, de-duplicated, at most MAX_BATCH_TOPICS. */
function cleanTopics(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of list) {
    const topic = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (!topic || seen.has(topic.toLowerCase())) continue;
    seen.add(topic.toLowerCase());
    out.push(topic);
  }
  return out;
}

/**
 * Queues several topics at once: each becomes its own video, researched and written in the
 * background one after another with the same format, niche and length.
 * Body: { topics: string[] | string (one per line), setup, targetMinutes, brief? }.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { topics?: unknown; setup?: unknown; style?: unknown; targetMinutes?: unknown; brief?: unknown };
  const topics = cleanTopics(body.topics);
  if (!topics.length) return NextResponse.json({ error: 'Add at least one topic (one per line).' }, { status: 400 });
  if (topics.length > MAX_BATCH_TOPICS) {
    return NextResponse.json({ error: `Queue at most ${MAX_BATCH_TOPICS} topics at a time.` }, { status: 400 });
  }
  const minutes = Number(body.targetMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) {
    return NextResponse.json({ error: 'targetMinutes must be between 0.5 and 60' }, { status: 400 });
  }
  try {
    const supabase = getSupabaseServerClient();
    const resolved = await resolveNewVideoStyle(body as { setup?: never; style?: unknown });
    const brief = typeof body.brief === 'string' ? trimBrief(body.brief) || null : null;
    const videos = [];
    for (const topic of topics) {
      const video = await createQueuedVideo(supabase, { mode: 'ai', topic, targetMinutes: minutes, brief }, resolved);
      videos.push({ id: video.id, topic });
    }
    return NextResponse.json({ videos }, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not queue the topics' }, { status: 500 });
  }
}
