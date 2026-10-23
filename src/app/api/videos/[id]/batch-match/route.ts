import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadStaged, matchStagedFiles, type StagedFile } from '@/pipeline/visuals/smart-match';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Proposes which staged file goes in which shot, by what the footage shows. Body: { fileIds }. */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const { fileIds } = (await req.json()) as { fileIds?: string[] };
    if (!Array.isArray(fileIds) || fileIds.length === 0) return NextResponse.json({ error: 'fileIds are required' }, { status: 400 });
    const staged = (await Promise.all(fileIds.slice(0, 60).map((f) => loadStaged(id, String(f))))).filter((s): s is StagedFile => Boolean(s));
    if (staged.length === 0) return NextResponse.json({ error: 'None of those files were found; drop them again' }, { status: 404 });
    const matches = await matchStagedFiles(getSupabaseServerClient(), id, staged);
    return NextResponse.json({ matches });
  } catch (err) {
    console.error('[SmartMatch] Matching failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
