import { NextResponse } from 'next/server';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { createSafeWebStream } from '@/lib/streaming';

export async function handleGetRender(
  req: Request,
  id: string,
  supabaseClient?: SupabaseClient,
) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return new NextResponse('Invalid or missing video ID', { status: 400 });
  }

  // ?preview=1: the quick preview render, and nothing else
  const preview = new URL(req.url).searchParams.get('preview') === '1';

  // 1. Check primary location: storage/renders/<id>/final_video.mp4
  let candidatePath = path.join(process.cwd(), 'storage', 'renders', id, preview ? 'preview.mp4' : 'final_video.mp4');
  let exists = await fsp
    .stat(candidatePath)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);
  if (preview && !exists) return new NextResponse('No preview yet', { status: 404 });

  // 2. If not found, check DB videos.render_url or latest job output
  if (!exists) {
    const supabase = supabaseClient ?? getSupabaseServerClient();
    const { data: video } = await supabase
      .from('videos')
      .select('render_url')
      .eq('id', id)
      .maybeSingle();

    if (video?.render_url && !video.render_url.startsWith('/api/')) {
      const diskPath = path.isAbsolute(video.render_url)
        ? video.render_url
        : path.join(process.cwd(), video.render_url);
      const isFile = await fsp
        .stat(diskPath)
        .then((s) => s.isFile() && s.size > 0)
        .catch(() => false);
      if (isFile) {
        candidatePath = diskPath;
        exists = true;
      }
    }

    if (!exists) {
      const { data: latestJob } = await supabase
        .from('yt_jobs')
        .select('id')
        .eq('video_id', id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestJob?.id) {
        const jobPath = path.join(process.cwd(), 'storage', 'jobs', latestJob.id, 'final_video.mp4');
        const isFile = await fsp
          .stat(jobPath)
          .then((s) => s.isFile() && s.size > 0)
          .catch(() => false);
        if (isFile) {
          candidatePath = jobPath;
          exists = true;
        }
      }
    }
  }

  if (!exists) {
    return new NextResponse('Rendered video not found on disk', { status: 404 });
  }

  const stat = await fsp.stat(candidatePath);
  const fileSize = stat.size;
  const rangeHeader = req.headers.get('range');

  // Support HTTP 206 Partial Content Range-requests for video streaming / scrubbing
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
      const fileStream = fs.createReadStream(candidatePath, { start, end });
      const webStream = createSafeWebStream(fileStream, { signal: req.signal });

      return new Response(webStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': 'video/mp4',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    }
  }

  // Full file response (HTTP 200)
  const fullStream = fs.createReadStream(candidatePath);
  const webStream = createSafeWebStream(fullStream, { signal: req.signal });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Length': String(fileSize),
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

export async function GET(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await props.params;
    return await handleGetRender(req, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return new NextResponse(message, { status: 500 });
  }
}
