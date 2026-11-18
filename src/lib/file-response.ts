import * as fs from 'node:fs';
import { stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { createSafeWebStream } from '@/lib/streaming';

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  wav: 'audio/wav',
  txt: 'text/plain; charset=utf-8',
};

/**
 * A file on disk as a response, honouring byte ranges so video players can seek.
 * `downloadName` makes the browser save it instead of showing it.
 */
export async function fileResponse(req: Request, file: string, downloadName?: string): Promise<Response> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return new NextResponse('Not found', { status: 404 });
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  const headers: Record<string, string> = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName.replace(/"/g, '')}"`;

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
