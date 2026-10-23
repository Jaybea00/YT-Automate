import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { compareVersion, deleteVersion, listVersions, restoreVersion, saveVersion } from '@/pipeline/vibedit/versions';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const validId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);
const fail = (err: unknown, status = 400) => NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });

/** The saved versions, newest first; ?compare=<id> lists the beats that look different now. */
export async function GET(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  const compare = new URL(req.url).searchParams.get('compare');
  try {
    if (compare) return NextResponse.json({ differences: await compareVersion(getSupabaseServerClient(), id, compare) });
    return NextResponse.json({ versions: await listVersions(id) });
  } catch (err) {
    return fail(err);
  }
}

/** { action: 'save', label } | { action: 'restore', versionId } | { action: 'delete', versionId } */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; label?: unknown; versionId?: unknown };
  const supabase = getSupabaseServerClient();
  try {
    if (body.action === 'save') {
      const version = await saveVersion(supabase, id, typeof body.label === 'string' ? body.label : '');
      return NextResponse.json({ version, versions: await listVersions(id) });
    }
    if (typeof body.versionId !== 'string') return NextResponse.json({ error: 'Which version?' }, { status: 400 });
    if (body.action === 'restore') {
      const result = await restoreVersion(supabase, id, body.versionId);
      return NextResponse.json({ ...result, versions: await listVersions(id) });
    }
    if (body.action === 'delete') {
      await deleteVersion(id, body.versionId);
      return NextResponse.json({ versions: await listVersions(id) });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return fail(err, 500);
  }
}
