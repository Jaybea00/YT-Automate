import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { addToLibrary, listLibrary, type LibraryClip } from '@/pipeline/visuals/clip-library';
import { ALLOWED_LICENSE_TYPES, type AllowedLicenseType } from '@/pipeline/utils/media-upload';

const DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024;

const publicClip = (c: LibraryClip) => ({
  id: c.id,
  name: c.name,
  isVideo: c.isVideo,
  durationSec: c.durationSec,
  description: c.description,
  tags: c.tags,
  license: c.license,
  attribution: c.attribution,
  addedAt: c.addedAt,
});

/** The clip library, newest first. */
export async function GET() {
  const clips = await listLibrary();
  return NextResponse.json({ clips: clips.map(publicClip).reverse() });
}

/** Adds one file (form fields: file, license_type, attribution_text); it's described by looking at it. */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'Missing field: file' }, { status: 400 });
    const maxBytes = process.env.MAX_UPLOAD_SIZE_BYTES ? Number.parseInt(process.env.MAX_UPLOAD_SIZE_BYTES, 10) : DEFAULT_MAX_SIZE_BYTES;
    if (file.size > maxBytes) return NextResponse.json({ error: `${file.name} is larger than the upload limit` }, { status: 400 });
    const license = ((form.get('license_type') as string | null) || 'own_work') as AllowedLicenseType;
    if (!ALLOWED_LICENSE_TYPES.includes(license)) return NextResponse.json({ error: 'Invalid license_type' }, { status: 400 });
    const attribution = (form.get('attribution_text') as string | null)?.trim() || null;
    if ((license === 'cc_by' || license === 'cc_by_sa') && !attribution) {
      return NextResponse.json({ error: 'attribution_text is required for CC BY footage' }, { status: 400 });
    }
    const clip = await addToLibrary(getSupabaseServerClient(), { name: file.name, buffer: Buffer.from(await file.arrayBuffer()), license, attribution });
    return NextResponse.json({ clip: publicClip(clip) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
