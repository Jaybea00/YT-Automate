import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loadComposedBeat, publicShot } from '@/pipeline/visuals/shot-editor';
import { editShot } from '@/pipeline/visuals/shot-editor-actions';
import { ALLOWED_LICENSE_TYPES, probeMediaFile, sniffMediaType, type AllowedLicenseType } from '@/pipeline/utils/media-upload';

interface RouteContext {
  params: Promise<{ id: string; index: string; shot: string }>;
}

const DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024;

/** Where a shot's upload is kept: next to the video's other uploads, one file per upload. */
function shotUploadPath(videoId: string, beatIndex: number, shotIndex: number, ext: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(videoId)) throw new Error('Invalid video id');
  const clean = ext.toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg');
  return path.join(process.cwd(), 'storage', 'uploads', videoId, 'shots', `beat-${beatIndex}-shot-${shotIndex}-${Date.now()}.${clean}`);
}

/**
 * Puts the creator's own photo or clip into one shot of a composed beat; the beat's other shots
 * (graphics included) stay as they are. Form fields: file, license_type (default own_work),
 * attribution_text, start_seconds (where to start in a video; otherwise the best part is found).
 */
export async function POST(req: Request, context: RouteContext) {
  const { id: videoId, index, shot } = await context.params;
  const beatIndex = Number.parseInt(index, 10);
  const shotIndex = Number.parseInt(shot, 10);
  if (!videoId || !Number.isInteger(beatIndex) || beatIndex < 0 || !Number.isInteger(shotIndex) || shotIndex < 0) {
    return NextResponse.json({ error: 'Invalid video, beat or shot' }, { status: 400 });
  }
  const supabase = getSupabaseServerClient();
  const beat = await loadComposedBeat(supabase, videoId, beatIndex);
  if (!beat || !beat.shots[shotIndex]) {
    return NextResponse.json({ error: 'This beat has no editable shot there' }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Send the file as multipart form data' }, { status: 400 });
  }
  const file = form.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'Missing field: file' }, { status: 400 });
  const maxBytes = process.env.MAX_UPLOAD_SIZE_BYTES ? Number.parseInt(process.env.MAX_UPLOAD_SIZE_BYTES, 10) : DEFAULT_MAX_SIZE_BYTES;
  if (file.size > maxBytes) {
    return NextResponse.json({ error: `The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit` }, { status: 400 });
  }
  const license = ((form.get('license_type') as string | null) || 'own_work') as AllowedLicenseType;
  if (!ALLOWED_LICENSE_TYPES.includes(license)) {
    return NextResponse.json({ error: `Invalid license_type. Allowed: ${ALLOWED_LICENSE_TYPES.join(', ')}` }, { status: 400 });
  }
  const attribution = (form.get('attribution_text') as string | null)?.trim() || null;
  if ((license === 'cc_by' || license === 'cc_by_sa') && !attribution) {
    return NextResponse.json({ error: 'attribution_text is required for CC BY footage' }, { status: 400 });
  }
  const startRaw = form.get('start_seconds');
  const startSec = startRaw !== null && startRaw !== '' ? Number(startRaw) : undefined;
  if (startSec !== undefined && !(startSec >= 0)) return NextResponse.json({ error: 'start_seconds must be 0 or more' }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffMediaType(buffer);
  if (!sniffed) return NextResponse.json({ error: 'Unsupported file: use mp4, mov, webm, jpg, png or webp' }, { status: 400 });

  const filePath = shotUploadPath(videoId, beatIndex, shotIndex, sniffed.ext);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, buffer);
  try {
    await probeMediaFile(filePath);
  } catch (err) {
    await fsp.unlink(filePath).catch(() => {});
    return NextResponse.json({ error: `The file can't be read: ${err instanceof Error ? err.message.slice(0, 200) : err}` }, { status: 400 });
  }

  try {
    const updated = await editShot({
      supabase,
      videoId,
      beat,
      shotIndex,
      edit: { action: 'upload', filePath, mediaType: sniffed.isVideo ? 'video' : 'image', license, attribution, startSec },
    });
    return NextResponse.json({ shot: publicShot(updated, shotIndex) });
  } catch (err) {
    console.error('[ShotEditor] Upload into shot failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
