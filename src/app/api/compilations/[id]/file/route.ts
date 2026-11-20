import type * as fs from 'node:fs';
import { stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import yazl from 'yazl';
import { fileResponse } from '@/lib/file-response';
import { createSafeWebStream } from '@/lib/streaming';
import { loadChannelProfile } from '@/pipeline/channel/store';
import { compilationUploadText } from '@/pipeline/compile/package';
import { compilationFile, loadCompilation } from '@/pipeline/compile/store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** ?name=video | thumbnail (with ?download=1 to save), or ?name=package for the zip. */
export async function GET(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const c = await loadCompilation(id);
  if (!c?.output) return new NextResponse('Not found', { status: 404 });
  const url = new URL(req.url);
  const name = url.searchParams.get('name') ?? 'video';
  const slug = (c.titles[0] || c.theme || 'compilation').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50).toLowerCase() || 'compilation';

  if (name === 'package') {
    const zip = new yazl.ZipFile();
    zip.addFile(compilationFile(id, c.output.video), `${slug}/${c.format === 'short' ? 'short' : 'video'}.mp4`);
    const thumb = compilationFile(id, c.output.thumbnail);
    if (await stat(thumb).then((s) => s.isFile()).catch(() => false)) zip.addFile(thumb, `${slug}/thumbnail.jpg`);
    zip.addBuffer(Buffer.from(compilationUploadText(c, await loadChannelProfile()), 'utf-8'), `${slug}/upload-info.txt`);
    zip.end();
    return new Response(createSafeWebStream(zip.outputStream as unknown as fs.ReadStream, { signal: req.signal }), {
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${slug}.zip"`, 'Cache-Control': 'no-cache' },
    });
  }
  const relative = name === 'thumbnail' ? c.output.thumbnail : c.output.video;
  const download = url.searchParams.get('download') === '1' ? `${slug}${name === 'thumbnail' ? '-thumbnail.jpg' : '.mp4'}` : undefined;
  return fileResponse(req, compilationFile(id, relative), download);
}
