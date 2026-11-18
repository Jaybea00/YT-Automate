import * as fs from 'node:fs';
import { stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import yazl from 'yazl';
import { createSafeWebStream } from '@/lib/streaming';
import { uploadInfoText } from '@/pipeline/clipping/package';
import { clipFile, loadClip } from '@/pipeline/clipping/store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const TYPES: Record<string, string> = { mp4: 'video/mp4', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', wav: 'audio/wav', txt: 'text/plain; charset=utf-8' };

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
  const file = clipFile(id, relative);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return new NextResponse('Not found', { status: 404 });

  const ext = relative.split('.').pop()?.toLowerCase() ?? '';
  const headers: Record<string, string> = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${slug}${name === 'thumbnail' ? '-thumbnail' : ''}.${ext}"`;

  // Byte ranges, so the video player can seek
  const range = req.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start >= info.size || start > end) return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
    return new Response(createSafeWebStream(fs.createReadStream(file, { start, end }), { signal: req.signal }), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(createSafeWebStream(fs.createReadStream(file), { signal: req.signal }), { headers: { ...headers, 'Content-Length': String(info.size) } });
}
