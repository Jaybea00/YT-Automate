import * as fsp from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadComposedBeat } from '@/pipeline/visuals/shot-editor';
import { editShot } from '@/pipeline/visuals/shot-editor-actions';
import { loadStaged } from '@/pipeline/visuals/smart-match';
import { ALLOWED_LICENSE_TYPES, type AllowedLicenseType } from '@/pipeline/utils/media-upload';
import { handleVisualUpload } from '../../beats/[index]/visual/route';

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ApplyItem {
  fileId: string;
  beat_index: number;
  shot_index: number | null;
  startSec?: number;
}

/**
 * Puts the confirmed matches in, one at a time: into the shot of a composed beat (its other shots
 * stay), or as the visual of a single-visual beat. Body: { matches, license_type, attribution_text }.
 */
export async function POST(req: Request, context: RouteContext) {
  const { id: videoId } = await context.params;
  const body = (await req.json().catch(() => ({}))) as { matches?: ApplyItem[]; license_type?: string; attribution_text?: string };
  const license = (body.license_type || 'own_work') as AllowedLicenseType;
  if (!ALLOWED_LICENSE_TYPES.includes(license)) return NextResponse.json({ error: 'Invalid license_type' }, { status: 400 });
  const attribution = body.attribution_text?.trim() || null;
  if ((license === 'cc_by' || license === 'cc_by_sa') && !attribution) {
    return NextResponse.json({ error: 'attribution_text is required for CC BY footage' }, { status: 400 });
  }
  if (!Array.isArray(body.matches) || body.matches.length === 0) return NextResponse.json({ error: 'No matches to apply' }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const results: Array<{ beat_index: number; shot_index: number | null; ok: boolean; error?: string }> = [];
  for (const m of body.matches) {
    const staged = await loadStaged(videoId, String(m.fileId));
    const startSec = typeof m.startSec === 'number' && m.startSec >= 0 ? m.startSec : undefined;
    try {
      if (!staged) throw new Error('File not found; drop it again');
      if (m.shot_index !== null && m.shot_index !== undefined) {
        const beat = await loadComposedBeat(supabase, videoId, m.beat_index);
        if (!beat?.shots[m.shot_index]) throw new Error('That shot no longer exists');
        await editShot({
          supabase,
          videoId,
          beat,
          shotIndex: m.shot_index,
          edit: { action: 'upload', filePath: staged.path, mediaType: staged.isVideo ? 'video' : 'image', license, attribution, startSec },
        });
      } else {
        const form = new FormData();
        form.append('file', new File([await fsp.readFile(staged.path)], staged.name));
        form.append('license_type', license);
        if (attribution) form.append('attribution_text', attribution);
        if (startSec !== undefined && staged.isVideo) form.append('start_offset_seconds', String(startSec));
        const res = await handleVisualUpload(new Request('http://localhost/upload', { method: 'POST', body: form }), videoId, String(m.beat_index), supabase);
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`);
      }
      results.push({ beat_index: m.beat_index, shot_index: m.shot_index ?? null, ok: true });
    } catch (err) {
      results.push({ beat_index: m.beat_index, shot_index: m.shot_index ?? null, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return NextResponse.json({ results });
}
