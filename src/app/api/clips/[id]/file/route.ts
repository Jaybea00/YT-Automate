import type * as fs from 'node:fs';
import { stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import yazl from 'yazl';
import { fileResponse } from '@/lib/file-response';
import { createSafeWebStream } from '@/lib/streaming';
import { uploadInfoText } from '@/pipeline/clipping/package';
import { clipFile, loadClip } from '@/pipeline/clipping/store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * A clip's files: ?name=video | thumbnail | source | frames/f00.jpg, with ?download=1 to save it,
 * or ?name=package for the export package (Short, thumbnail and upload details) as one zip.
 */
export async function GET(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const clip = await loadClip(id);
  if (!clip) return new NextResponse('Not found', { status: 404 });
  const url = new URL(req.url);
  const name = url.searchParams.get('name') ?? 'video';
  const download = url.searchParams.get('download') === '1';
  const slug = (clip.plan?.titles[0] || 'short').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50).toLowerCase() || 'short';

  if (name === 'package') {
    if (!clip.output) return new NextResponse('The Short is not rendered yet', { status: 409 });
    const zip = new yazl.ZipFile();
    zip.addFile(clipFile(id, clip.output.video), `${slug}/short.mp4`);
    const thumb = clipFile(id, clip.output.thumbnail);
    if (await stat(thumb).then((s) => s.isFile()).catch(() => false)) zip.addFile(thumb, `${slug}/thumbnail.jpg`);
    zip.addBuffer(Buffer.from(uploadInfoText(clip), 'utf-8'), `${slug}/upload-info.txt`);
    zip.end();
    return new Response(createSafeWebStream(zip.outputStream as unknown as fs.ReadStream, { signal: req.signal }), {
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${slug}.zip"`, 'Cache-Control': 'no-cache' },
    });
  }

  const relative =
    name === 'video' ? clip.output?.video : name === 'thumbnail' ? clip.output?.thumbnail : name === 'source' ? clip.source?.file : /^frames\/f\d{2}\.jpg$/.test(name) ? name : null;
  if (!relative) return new NextResponse('Not found', { status: 404 });
  const ext = relative.split('.').pop()?.toLowerCase() ?? '';
  return fileResponse(req, clipFile(id, relative), download ? `${slug}${name === 'thumbnail' ? '-thumbnail' : ''}.${ext}` : undefined);
}
