import * as fs from 'node:fs';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { createSafeWebStream } from '@/lib/streaming';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export function getVisualMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.mp4':
    default:
      return 'video/mp4';
  }
}

export async function handleVisualRequest(
  req: Request,
  jobId: string,
  unitIndexStr: string,
  supabaseClient?: SupabaseClient,
) {
  if (!jobId || !unitIndexStr) {
    return new NextResponse('Job ID and Unit Index are required', { status: 404 });
  }

  const unitIndex = parseInt(unitIndexStr, 10);
  if (Number.isNaN(unitIndex)) {
    return new NextResponse('Invalid unit index', { status: 404 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();

  // 1. Look up the yt_job_units row for that jobId + stage='visuals' + unit_index
  const { data: unit, error } = await supabase
    .from('yt_job_units')
    .select('output_path, status, stage')
    .eq('job_id', jobId)
    .eq('stage', 'visuals')
    .eq('unit_index', unitIndex)
    .maybeSingle();

  // 2. 404 if not found or status !== 'done' or no output_path
  if (error || !unit || unit.status !== 'done' || !unit.output_path) {
    return new NextResponse('Unit visual not found or not done', { status: 404 });
  }

  // 3. Read the file at its output_path (DB-stored path only)
  let fileStats;
  try {
    fileStats = await stat(unit.output_path);
    if (!fileStats.isFile()) {
      return new NextResponse('Visual file not found', { status: 404 });
    }
  } catch {
    return new NextResponse('Visual file not found', { status: 404 });
  }

  const fileSize = fileStats.size;
  const mimeType = getVisualMimeType(unit.output_path);
  const rangeHeader = req.headers.get('range');

  // Support HTTP Range requests for seeking/scrubbing in HTML5 video players
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        return new NextResponse('Requested range not satisfiable', {
          status: 416,
          headers: {
            'Content-Range': `bytes */${fileSize}`,
          },
        });
      }

      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(unit.output_path, { start, end });
      const webStream = createSafeWebStream(fileStream, { signal: req.signal });

      return new Response(webStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize.toString(),
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }
  }

  // Full file stream (e.g. initial load or images)
  const fileStream = fs.createReadStream(unit.output_path);
  const webStream = createSafeWebStream(fileStream, { signal: req.signal });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Length': fileSize.toString(),
      'Accept-Ranges': 'bytes',
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export async function GET(
  req: Request,
  props: { params: Promise<{ jobId: string; unitIndex: string }> },
) {
  try {
    const { jobId, unitIndex } = await props.params;
    return await handleVisualRequest(req, jobId, unitIndex);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return new NextResponse(message, { status: 500 });
  }
}
