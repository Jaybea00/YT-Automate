import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { createSafeWebStream } from '@/lib/streaming';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import {
  sniffMediaType,
  probeMediaFile,
  getSafeUploadPath,
  deleteExistingBeatUploads,
  findExistingBeatUpload,
  computeUploadWarnings,
  invalidateBeatAssemblyCache,
  ALLOWED_LICENSE_TYPES,
  type AllowedLicenseType,
} from '@/pipeline/utils/media-upload';
import { upsertVideoAssetProvenance } from '@/pipeline/visuals/provenance';

const DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

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
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.mp4':
    default:
      return 'video/mp4';
  }
}

export async function handleVisualUpload(
  req: Request,
  videoId: string,
  indexStr: string,
  supabaseClient?: SupabaseClient,
) {
  if (!videoId || !/^[a-zA-Z0-9_-]+$/.test(videoId)) {
    return NextResponse.json({ error: 'Invalid or missing video ID' }, { status: 400 });
  }

  const beatIndex = parseInt(indexStr, 10);
  if (Number.isNaN(beatIndex) || beatIndex < 0) {
    return NextResponse.json({ error: 'Invalid beat index: must be a non-negative integer' }, { status: 400 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();

  // 1. Verify video exists and beat index is valid
  const { data: video, error: videoError } = await supabase
    .from('videos')
    .select('id, script_json')
    .eq('id', videoId)
    .maybeSingle();

  if (videoError || !video) {
    return NextResponse.json({ error: `Video "${videoId}" not found` }, { status: 404 });
  }

  const beats = video.script_json?.beats;
  if (Array.isArray(beats) && beats.length > 0) {
    if (beatIndex >= beats.length) {
      return NextResponse.json(
        { error: `Beat index ${beatIndex} is out of bounds (video has ${beats.length} beats)` },
        { status: 400 },
      );
    }
  }

  // 2. Parse multipart form data
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid multipart form data: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    );
  }

  const file = formData.get('file') as File | null;
  const licenseType = formData.get('license_type') as string | null;
  const sourceNote = (formData.get('source_note') as string | null)?.trim() || null;
  const attributionText = (formData.get('attribution_text') as string | null)?.trim() || null;

  if (!file) {
    return NextResponse.json({ error: 'Missing required field: file' }, { status: 400 });
  }

  // Enforce configurable max size
  const maxSizeBytes = process.env.MAX_UPLOAD_SIZE_BYTES
    ? parseInt(process.env.MAX_UPLOAD_SIZE_BYTES, 10)
    : DEFAULT_MAX_SIZE_BYTES;

  if (file.size > maxSizeBytes) {
    return NextResponse.json(
      {
        error: `File size (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds allowed limit of ${(maxSizeBytes / (1024 * 1024)).toFixed(0)} MB`,
      },
      { status: 400 },
    );
  }

  // Validate license fields
  if (!licenseType || !ALLOWED_LICENSE_TYPES.includes(licenseType as AllowedLicenseType)) {
    return NextResponse.json(
      { error: `Invalid license_type. Allowed types: ${ALLOWED_LICENSE_TYPES.join(', ')}` },
      { status: 400 },
    );
  }

  if ((licenseType === 'cc_by' || licenseType === 'cc_by_sa') && (!attributionText || !attributionText.trim())) {
    return NextResponse.json(
      { error: 'attribution_text is required when license_type is cc_by or cc_by_sa' },
      { status: 400 },
    );
  }

  // 3. Read buffer and sniff content
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const sniffResult = sniffMediaType(buffer);
  if (!sniffResult) {
    return NextResponse.json(
      {
        error: 'Invalid file format rejected by content sniffing. Allowed formats: mp4, mov, webm, jpg, jpeg, png, webp',
      },
      { status: 400 },
    );
  }

  // 4. Safe destination path
  const { uploadDir, filePath } = getSafeUploadPath(videoId, beatIndex, sniffResult.ext);

  // 5. Delete any existing upload for this beat (clean replacement)
  await deleteExistingBeatUploads(videoId, beatIndex);

  // 6. Write file to disk
  await fsp.mkdir(uploadDir, { recursive: true });
  await fsp.writeFile(filePath, buffer);

  // 7. Run ffprobe to validate readability and obtain media dimensions & duration
  let probeInfo;
  try {
    probeInfo = await probeMediaFile(filePath);
  } catch (err) {
    // Clean up unreadable file on failure
    await fsp.unlink(filePath).catch(() => {});
    return NextResponse.json(
      { error: `File failed ffprobe media validation: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    );
  }

  // 8. Query measured TTS duration for warning check
  let ttsDurationMs: number | null = null;
  const { data: jobs } = await supabase
    .from('yt_jobs')
    .select('id')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false });

  if (jobs && jobs.length > 0) {
    const jobIds = jobs.map((j) => j.id);
    const { data: units } = await supabase
      .from('yt_job_units')
      .select('duration_ms, job_id')
      .in('job_id', jobIds)
      .eq('stage', 'tts')
      .eq('unit_index', beatIndex)
      .eq('status', 'done');

    if (units && units.length > 0) {
      const validUnits = units.filter((u) => u.duration_ms != null && u.duration_ms > 0);
      const unitMap = new Map(validUnits.map((u) => [u.job_id, u.duration_ms]));
      for (const j of jobs) {
        if (unitMap.has(j.id)) {
          ttsDurationMs = unitMap.get(j.id)!;
          break;
        }
      }
    }
  }

  // 9. Compute warnings
  const warnings = computeUploadWarnings(probeInfo, ttsDurationMs);

  const startOffsetRaw = formData.get('start_offset_seconds');
  const startOffsetSeconds =
    startOffsetRaw != null && !Number.isNaN(parseFloat(String(startOffsetRaw)))
      ? Math.max(0, parseFloat(String(startOffsetRaw)))
      : 0;

  const endOffsetRaw = formData.get('end_offset_seconds');
  const endOffsetSeconds =
    endOffsetRaw != null && !Number.isNaN(parseFloat(String(endOffsetRaw)))
      ? parseFloat(String(endOffsetRaw))
      : null;

  // 10. Upsert video_assets row
  await upsertVideoAssetProvenance(supabase, {
    video_id: videoId,
    beat_index: beatIndex,
    visual_type: 'uploaded',
    source_url: filePath,
    license_type: licenseType,
    license_source: sourceNote || 'manual_upload',
    attribution_text: attributionText,
    license_proof_url: null,
    start_offset_seconds: startOffsetSeconds,
    end_offset_seconds: endOffsetSeconds,
  });

  // Sync trim_offsets into videos.script_json
  const currentScriptJson = video.script_json || {};
  const trimOffsets = { ...(currentScriptJson.trim_offsets || {}) };
  trimOffsets[beatIndex] = {
    start_offset_seconds: startOffsetSeconds,
    end_offset_seconds: endOffsetSeconds,
  };
  await supabase
    .from('videos')
    .update({
      script_json: { ...currentScriptJson, trim_offsets: trimOffsets },
    })
    .eq('id', videoId);

  // Invalidate any stale rendered assembly clips for this beat so reassembly is forced to render the new upload
  await invalidateBeatAssemblyCache(supabase, videoId, beatIndex);

  // Fetch the newly upserted record to return
  const { data: assetRecord } = await supabase
    .from('video_assets')
    .select('*')
    .eq('video_id', videoId)
    .eq('beat_index', beatIndex)
    .maybeSingle();

  return NextResponse.json(
    {
      asset: assetRecord,
      warnings,
      probe: probeInfo,
    },
    { status: 200 },
  );
}

export async function handleGetVisual(
  req: Request,
  videoId: string,
  indexStr: string,
  supabaseClient?: SupabaseClient,
) {
  if (!videoId || !/^[a-zA-Z0-9_-]+$/.test(videoId)) {
    return new NextResponse('Invalid or missing video ID', { status: 400 });
  }

  const beatIndex = parseInt(indexStr, 10);
  if (Number.isNaN(beatIndex) || beatIndex < 0) {
    return new NextResponse('Invalid beat index', { status: 400 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();

  let targetFilePath: string | null = null;

  // 1. If an uploaded / generated asset exists on disk (e.g. beat-0.mp4, beat-0.mov, beat-0.jpg, beat-0.png), prioritize it
  const existing = await findExistingBeatUpload(videoId, beatIndex);
  if (existing?.filePath) {
    const isFile = await fsp
      .stat(existing.filePath)
      .then((s) => s.isFile() && s.size > 0)
      .catch(() => false);
    if (isFile) {
      targetFilePath = existing.filePath;
    }
  }

  // 2. Check video_assets record for source_url pointing to local file (e.g. downloaded candidates / swaps)
  if (!targetFilePath) {
    const { data: asset } = await supabase
      .from('video_assets')
      .select('source_url')
      .eq('video_id', videoId)
      .eq('beat_index', beatIndex)
      .maybeSingle();

    if (asset?.source_url) {
      const diskPath = path.isAbsolute(asset.source_url)
        ? asset.source_url
        : path.join(process.cwd(), asset.source_url);
      const isFile = await fsp
        .stat(diskPath)
        .then((s) => s.isFile() && s.size > 0)
        .catch(() => false);
      if (isFile) {
        targetFilePath = diskPath;
      }
    }
  }

  // 3. Fallback: check rendered assembly scene clip (scene_<beatIndex>.mp4) from latest jobs
  if (!targetFilePath) {
    const { data: latestJob } = await supabase
      .from('yt_jobs')
      .select('id')
      .eq('video_id', videoId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestJob?.id) {
      // 3a. Check yt_job_units output_path
      const { data: assemblyUnit } = await supabase
        .from('yt_job_units')
        .select('output_path')
        .eq('job_id', latestJob.id)
        .eq('stage', 'assembly')
        .eq('unit_index', beatIndex)
        .eq('status', 'done')
        .maybeSingle();

      if (assemblyUnit?.output_path) {
        const isFile = await fsp
          .stat(assemblyUnit.output_path)
          .then((s) => s.isFile() && s.size > 0)
          .catch(() => false);
        if (isFile) {
          targetFilePath = assemblyUnit.output_path;
        }
      }

      // 3b. Check disk directly in storage/jobs/<jobId>/temp_assembly/scene_<beatIndex>.mp4
      if (!targetFilePath) {
        const directScenePath = path.join(
          process.cwd(),
          'storage',
          'jobs',
          latestJob.id,
          'temp_assembly',
          `scene_${beatIndex}.mp4`,
        );
        const isFile = await fsp
          .stat(directScenePath)
          .then((s) => s.isFile() && s.size > 0)
          .catch(() => false);
        if (isFile) {
          targetFilePath = directScenePath;
        }
      }
    }
  }

  // 4. Fallback: check any existing job directory for this video that has temp_assembly/scene_<beatIndex>.mp4
  if (!targetFilePath) {
    const { data: allJobs } = await supabase
      .from('yt_jobs')
      .select('id')
      .eq('video_id', videoId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (allJobs && allJobs.length > 0) {
      for (const j of allJobs) {
        const candidate = path.join(
          process.cwd(),
          'storage',
          'jobs',
          j.id,
          'temp_assembly',
          `scene_${beatIndex}.mp4`,
        );
        const isFile = await fsp
          .stat(candidate)
          .then((s) => s.isFile() && s.size > 0)
          .catch(() => false);
        if (isFile) {
          targetFilePath = candidate;
          break;
        }
      }
    }
  }

  // 6. Fallback: check yt_job_units visuals stage
  if (!targetFilePath) {
    const { data: latestJob } = await supabase
      .from('yt_jobs')
      .select('id')
      .eq('video_id', videoId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestJob?.id) {
      const { data: visualUnit } = await supabase
        .from('yt_job_units')
        .select('output_path')
        .eq('job_id', latestJob.id)
        .eq('stage', 'visuals')
        .eq('unit_index', beatIndex)
        .eq('status', 'done')
        .maybeSingle();

      if (visualUnit?.output_path) {
        const isFile = await fsp
          .stat(visualUnit.output_path)
          .then((s) => s.isFile() && s.size > 0)
          .catch(() => false);
        if (isFile) {
          targetFilePath = visualUnit.output_path;
        }
      }
    }
  }

  if (!targetFilePath) {
    return new NextResponse('Visual file not found on disk for this beat', { status: 404 });
  }

  let fileStats;
  try {
    fileStats = await fsp.stat(targetFilePath);
    if (!fileStats.isFile()) {
      return new NextResponse('Visual file not found on disk', { status: 404 });
    }
  } catch {
    return new NextResponse('Visual file not found on disk', { status: 404 });
  }

  const fileSize = fileStats.size;
  const mimeType = getVisualMimeType(targetFilePath);


  // If HEAD request, return headers immediately without streaming body
  if (req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Length': fileSize.toString(),
        'Accept-Ranges': 'bytes',
        'Content-Type': mimeType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  }

  const rangeHeader = req.headers.get('range');

  // Support HTTP Range requests for video scrubbing & seeking
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
      const fileStream = fs.createReadStream(targetFilePath, { start, end });
      const webStream = createSafeWebStream(fileStream, { signal: req.signal });

      return new Response(webStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize.toString(),
          'Content-Type': mimeType,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    }
  }

  // Full file stream
  const fileStream = fs.createReadStream(targetFilePath);
  const webStream = createSafeWebStream(fileStream, { signal: req.signal });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Length': fileSize.toString(),
      'Accept-Ranges': 'bytes',
      'Content-Type': mimeType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

export async function handlePatchVisual(
  req: Request,
  videoId: string,
  indexStr: string,
  supabaseClient?: SupabaseClient,
) {
  if (!videoId || !/^[a-zA-Z0-9_-]+$/.test(videoId)) {
    return NextResponse.json({ error: 'Invalid or missing video ID' }, { status: 400 });
  }

  const beatIndex = parseInt(indexStr, 10);
  if (Number.isNaN(beatIndex) || beatIndex < 0) {
    return NextResponse.json({ error: 'Invalid beat index' }, { status: 400 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();

  const body = await req.json().catch(() => ({}));
  const startOffsetSeconds =
    body.start_offset_seconds != null && !Number.isNaN(parseFloat(String(body.start_offset_seconds)))
      ? Math.max(0, parseFloat(String(body.start_offset_seconds)))
      : 0;

  const endOffsetSeconds =
    body.end_offset_seconds != null && !Number.isNaN(parseFloat(String(body.end_offset_seconds)))
      ? parseFloat(String(body.end_offset_seconds))
      : null;

  // 1. Update video_assets
  const { data: asset, error: assetErr } = await supabase
    .from('video_assets')
    .select('id')
    .eq('video_id', videoId)
    .eq('beat_index', beatIndex)
    .maybeSingle();

  if (assetErr) {
    return NextResponse.json({ error: assetErr.message }, { status: 500 });
  }

  if (asset?.id) {
    await supabase
      .from('video_assets')
      .update({
        start_offset_seconds: startOffsetSeconds,
        end_offset_seconds: endOffsetSeconds,
      })
      .eq('id', asset.id);
  }

  // 2. Also sync to videos.script_json.trim_offsets
  const { data: video } = await supabase
    .from('videos')
    .select('id, script_json')
    .eq('id', videoId)
    .maybeSingle();

  if (video) {
    const currentScriptJson = video.script_json || {};
    const trimOffsets = { ...(currentScriptJson.trim_offsets || {}) };
    trimOffsets[beatIndex] = {
      start_offset_seconds: startOffsetSeconds,
      end_offset_seconds: endOffsetSeconds,
    };
    await supabase
      .from('videos')
      .update({
        script_json: { ...currentScriptJson, trim_offsets: trimOffsets },
      })
      .eq('id', videoId);
  }

  // Fetch updated asset
  const { data: updatedAsset } = await supabase
    .from('video_assets')
    .select('*')
    .eq('video_id', videoId)
    .eq('beat_index', beatIndex)
    .maybeSingle();

  return NextResponse.json({
    success: true,
    asset: updatedAsset || {
      beat_index: beatIndex,
      start_offset_seconds: startOffsetSeconds,
      end_offset_seconds: endOffsetSeconds,
    },
  });
}

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string; index: string }> },
) {
  try {
    const { id, index } = await props.params;
    return await handleVisualUpload(req, id, index);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  props: { params: Promise<{ id: string; index: string }> },
) {
  try {
    const { id, index } = await props.params;
    return await handlePatchVisual(req, id, index);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(
  req: Request,
  props: { params: Promise<{ id: string; index: string }> },
) {
  try {
    const { id, index } = await props.params;
    return await handleGetVisual(req, id, index);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return new NextResponse(message, { status: 500 });
  }
}

export async function HEAD(
  req: Request,
  props: { params: Promise<{ id: string; index: string }> },
) {
  try {
    const { id, index } = await props.params;
    return await handleGetVisual(req, id, index);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return new NextResponse(message, { status: 500 });
  }
}

