import { NextResponse } from 'next/server';
import { stageFile } from '@/pipeline/visuals/smart-match';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024;

/** Saves one dropped file for smart matching (form field "file"). Nothing in the video changes yet. */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'Missing field: file' }, { status: 400 });
    const maxBytes = process.env.MAX_UPLOAD_SIZE_BYTES ? Number.parseInt(process.env.MAX_UPLOAD_SIZE_BYTES, 10) : DEFAULT_MAX_SIZE_BYTES;
    if (file.size > maxBytes) return NextResponse.json({ error: `${file.name} is larger than the upload limit` }, { status: 400 });
    const staged = await stageFile(id, file.name, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ id: staged.id, name: staged.name, isVideo: staged.isVideo, durationSec: staged.durationSec });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
