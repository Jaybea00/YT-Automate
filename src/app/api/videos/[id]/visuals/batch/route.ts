import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { handleVisualUpload } from '@/app/api/videos/[id]/beats/[index]/visual/route';
import { extractBeatIndexFromFilename } from '@/lib/visuals/batch-mapper';

export interface BatchUploadResult {
  fileName: string;
  beatIndex: number | null;
  success: boolean;
  warnings?: string[];
  error?: string;
}

export async function handleBatchVisualUpload(
  req: Request,
  videoId: string,
  supabaseClient?: SupabaseClient,
) {
  if (!videoId || !/^[a-zA-Z0-9_-]+$/.test(videoId)) {
    return NextResponse.json({ error: 'Invalid or missing video ID' }, { status: 400 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();

  // 1. Verify video exists and get beat count
  const { data: video, error: videoError } = await supabase
    .from('videos')
    .select('id, script_json')
    .eq('id', videoId)
    .maybeSingle();

  if (videoError || !video) {
    return NextResponse.json({ error: `Video "${videoId}" not found` }, { status: 404 });
  }

  const beats = video.script_json?.beats || [];
  const totalBeats = beats.length;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid multipart form data: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    );
  }

  const defaultLicense = (formData.get('default_license') as string) || 'own_work';
  const defaultSourceNote = (formData.get('default_source_note') as string) || '';
  const defaultAttribution = (formData.get('default_attribution') as string) || '';

  // Extract all file entries
  const fileEntries: Array<{ file: File; beatIndex: number | null; license?: string }> = [];

  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      // Check if key is formatted as "file_0", "file_1" or "beat_0"
      const keyMatch = key.match(/(?:file|beat)[-_]?(\d+)/i);
      let beatIndex: number | null = null;

      if (keyMatch) {
        beatIndex = parseInt(keyMatch[1], 10);
      } else {
        // Fall back to extracting beat index from filename
        beatIndex = extractBeatIndexFromFilename(value.name, totalBeats);
      }

      const itemLicense = (formData.get(`license_${beatIndex}`) as string) || defaultLicense;

      fileEntries.push({
        file: value,
        beatIndex,
        license: itemLicense,
      });
    }
  }

  if (fileEntries.length === 0) {
    return NextResponse.json(
      { error: 'No files provided in multipart form data.' },
      { status: 400 },
    );
  }

  const results: BatchUploadResult[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const entry of fileEntries) {
    if (entry.beatIndex === null || entry.beatIndex < 0 || entry.beatIndex >= totalBeats) {
      results.push({
        fileName: entry.file.name,
        beatIndex: entry.beatIndex,
        success: false,
        error: `Could not assign to valid beat (total beats: ${totalBeats})`,
      });
      failCount++;
      continue;
    }

    try {
      // Create sub-request for this specific beat
      const subFormData = new FormData();
      subFormData.append('file', entry.file);
      subFormData.append('license_type', entry.license || defaultLicense);
      if (defaultSourceNote) subFormData.append('source_note', defaultSourceNote);
      if (defaultAttribution) subFormData.append('attribution_text', defaultAttribution);

      const subReq = new Request(`http://localhost/api/videos/${videoId}/beats/${entry.beatIndex}/visual`, {
        method: 'POST',
        body: subFormData,
      });

      const response = await handleVisualUpload(subReq, videoId, String(entry.beatIndex), supabase);
      const resJson = await response.json();

      if (!response.ok) {
        results.push({
          fileName: entry.file.name,
          beatIndex: entry.beatIndex,
          success: false,
          error: resJson.error || `Upload failed with HTTP ${response.status}`,
        });
        failCount++;
      } else {
        results.push({
          fileName: entry.file.name,
          beatIndex: entry.beatIndex,
          success: true,
          warnings: resJson.warnings,
        });
        successCount++;
      }
    } catch (err) {
      results.push({
        fileName: entry.file.name,
        beatIndex: entry.beatIndex,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown upload error',
      });
      failCount++;
    }
  }

  return NextResponse.json({
    total: fileEntries.length,
    successful: successCount,
    failed: failCount,
    results,
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleBatchVisualUpload(req, id);
}
