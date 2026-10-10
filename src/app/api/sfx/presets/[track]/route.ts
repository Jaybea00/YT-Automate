import { NextResponse } from 'next/server';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSafeWebStream } from '@/lib/streaming';
import { ensureDefaultSfxPresets } from '@/pipeline/assembly/sfx';

export async function GET(
  req: Request,
  props: { params: Promise<{ track: string }> },
) {
  const { track } = await props.params;

  if (!track || !/^[a-zA-Z0-9_-]+$/.test(track)) {
    return new NextResponse('Invalid SFX track name', { status: 400 });
  }

  await ensureDefaultSfxPresets().catch(() => {});

  const presetPath = path.join(process.cwd(), 'storage', 'sfx', 'presets', `${track}.mp3`);
  const exists = await fsp
    .stat(presetPath)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);

  if (!exists) {
    return new NextResponse('SFX preset audio not found', { status: 404 });
  }

  const stat = await fsp.stat(presetPath);
  const fileSize = stat.size;
  const rangeHeader = req.headers.get('range');

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        return new NextResponse('Requested range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${fileSize}` },
        });
      }

      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(presetPath, { start, end });
      const webStream = createSafeWebStream(fileStream, { signal: req.signal });

      return new Response(webStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': 'audio/mpeg',
        },
      });
    }
  }

  const fullStream = fs.createReadStream(presetPath);
  const webStream = createSafeWebStream(fullStream, { signal: req.signal });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Length': String(fileSize),
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
    },
  });
}
