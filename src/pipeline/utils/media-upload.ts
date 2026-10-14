import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getFfprobePath } from './ffmpeg';

const execFileAsync = promisify(execFile);

export const ALLOWED_EXTENSIONS = ['mp4', 'mov', 'webm', 'jpg', 'jpeg', 'png', 'webp'] as const;
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

export const ALLOWED_LICENSE_TYPES = [
  'own_work',
  'purchased',
  'royalty_free',
  'public_domain',
  'cc0',
  'cc_by',
  'cc_by_sa',
  'fair_use',
] as const;
export type AllowedLicenseType = (typeof ALLOWED_LICENSE_TYPES)[number];

/**
 * Licenses a monetised channel can't use for edited footage: NonCommercial forbids monetised
 * use, NoDerivatives forbids the cropping, zooming and cutting the pipeline applies.
 */
export function isUnusableLicense(raw?: string | null): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return /(?:^|[\s/_-])(nc|nd)(?:[\s/_.-]|$)|by-nc|by-nd|by_nc|by_nd|noncommercial|non-commercial|noderiv|no-deriv/.test(lower);
}

/**
 * Normalizes an arbitrary license string (e.g. from Wikimedia, Archive.org, Pexels)
 * into one of the allowed database enum values:
 * 'own_work' | 'purchased' | 'royalty_free' | 'public_domain' | 'cc0' | 'cc_by' | 'fair_use'
 */
export function normalizeLicenseType(raw?: string | null): AllowedLicenseType {
  if (!raw) return 'royalty_free';
  const lower = raw.toLowerCase().trim();

  // If already exact match
  if (ALLOWED_LICENSE_TYPES.includes(lower as AllowedLicenseType)) {
    return lower as AllowedLicenseType;
  }

  // CC0 variations (check before public domain so publicdomain/zero maps to cc0)
  if (lower.includes('cc0') || lower.includes('zero') || lower.includes('/zero/')) {
    return 'cc0';
  }

  // Public domain variations
  if (
    lower.includes('public domain') ||
    lower.includes('public_domain') ||
    lower.includes('publicdomain') ||
    lower.includes('no restrictions') ||
    lower.startsWith('pd') ||
    lower.includes('/pd') ||
    lower.includes('pd-') ||
    lower.includes('pdm')
  ) {
    return 'public_domain';
  }

  // ShareAlike must stay ShareAlike: it carries different obligations than plain CC BY
  if (lower.includes('by-sa') || lower.includes('by_sa') || lower.includes('licenses/by-sa') || /cc[\s-]?by[\s-]sa/.test(lower)) {
    return 'cc_by_sa';
  }

  // CC BY variations (NC/ND variants are filtered out before this via isUnusableLicense)
  if (
    lower.includes('cc by') ||
    lower.includes('cc-by') ||
    lower.includes('cc_by') ||
    lower.includes('attribution') ||
    lower.includes('licenses/by') ||
    lower.includes('/by/')
  ) {
    return 'cc_by';
  }

  // Fair use
  if (lower.includes('fair use') || lower.includes('fair_use')) {
    return 'fair_use';
  }

  // Own work
  if (lower.includes('own work') || lower.includes('own_work')) {
    return 'own_work';
  }

  // Purchased / Commercial
  if (lower.includes('purchased') || lower.includes('commercial')) {
    return 'purchased';
  }

  return 'royalty_free';
}

export interface SniffedMedia {
  ext: 'mp4' | 'mov' | 'webm' | 'jpg' | 'png' | 'webp';
  mime: string;
  isVideo: boolean;
}

export interface MediaProbeInfo {
  width: number;
  height: number;
  durationMs: number;
  isVideo: boolean;
  aspectRatio: number;
}

/**
 * Sniffs binary magic bytes from the start of a buffer to determine the true media type.
 * Rejects non-media or unrecognized formats regardless of file extension.
 */
export function sniffMediaType(buffer: Buffer): SniffedMedia | null {
  if (!buffer || buffer.length < 12) {
    return null;
  }

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png', isVideo: false };
  }

  // 2. JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg', isVideo: false };
  }

  // 3. WEBP: 'RIFF' .... 'WEBP'
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp', isVideo: false };
  }

  // 4. WEBM / MKV: 1A 45 DF A3
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return { ext: 'webm', mime: 'video/webm', isVideo: true };
  }

  // 5. MP4 / MOV (ISO Base Media File Format)
  // Box type at offset 4..7: 'ftyp', 'moov', 'mdat', 'wide', 'free'
  const boxType = buffer.subarray(4, 8).toString('ascii');
  if (boxType === 'ftyp') {
    const majorBrand = buffer.subarray(8, 12).toString('ascii');
    if (majorBrand.startsWith('qt')) {
      return { ext: 'mov', mime: 'video/quicktime', isVideo: true };
    }
    return { ext: 'mp4', mime: 'video/mp4', isVideo: true };
  }
  if (boxType === 'moov' || boxType === 'mdat' || boxType === 'wide') {
    return { ext: 'mov', mime: 'video/quicktime', isVideo: true };
  }

  return null;
}

/**
 * Runs ffprobe to read width, height, and duration of a visual file.
 * Rejects corrupt, unreadable, or non-visual files.
 */
export async function probeMediaFile(filePath: string): Promise<MediaProbeInfo> {
  const ffprobeBin = getFfprobePath();

  let stdout: string;
  try {
    const res = await execFileAsync(ffprobeBin, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,duration:format=duration',
      '-of',
      'json',
      filePath,
    ]);
    stdout = res.stdout;
  } catch (err) {
    throw new Error(
      `Corrupt or unreadable media file: ffprobe failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  let data: {
    streams?: Array<{ width?: number | string; height?: number | string; duration?: string }>;
    format?: { duration?: string };
  };
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('Unreadable media file: ffprobe returned invalid metadata');
  }

  const stream = data?.streams?.[0];
  if (!stream || !stream.width || !stream.height) {
    throw new Error('Unreadable media file: no visual video or image stream found');
  }

  const width = Number(stream.width);
  const height = Number(stream.height);
  if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
    throw new Error('Unreadable media file: invalid media dimensions');
  }

  let durationSec = 0;
  if (stream.duration && !isNaN(parseFloat(stream.duration))) {
    durationSec = parseFloat(stream.duration);
  } else if (data?.format?.duration && !isNaN(parseFloat(data.format.duration))) {
    durationSec = parseFloat(data.format.duration);
  }

  const isVideo = durationSec > 0;
  const durationMs = isVideo ? Math.round(durationSec * 1000) : 0;
  const aspectRatio = width / height;

  return {
    width,
    height,
    durationMs,
    isVideo,
    aspectRatio,
  };
}

/**
 * Validates request parameters and builds a safe, non-traversable file path under storage/uploads/<videoId>/beat-<index>.<ext>.
 */
export function getSafeUploadPath(
  videoId: string,
  beatIndex: number,
  ext: string,
): { uploadDir: string; fileName: string; filePath: string } {
  if (!videoId || !/^[a-zA-Z0-9_-]+$/.test(videoId)) {
    throw new Error(`Invalid videoId: "${videoId}"`);
  }
  if (!Number.isInteger(beatIndex) || beatIndex < 0) {
    throw new Error(`Invalid beatIndex: ${beatIndex}`);
  }

  const normalizedExt = ext.toLowerCase().replace(/^\./, '');
  if (!ALLOWED_EXTENSIONS.includes(normalizedExt as AllowedExtension)) {
    throw new Error(`Invalid file extension: "${normalizedExt}"`);
  }

  const uploadDir = path.join(process.cwd(), 'storage', 'uploads', videoId);
  const fileName = `beat-${beatIndex}.${normalizedExt === 'jpeg' ? 'jpg' : normalizedExt}`;
  const filePath = path.join(uploadDir, fileName);

  return { uploadDir, fileName, filePath };
}

/**
 * Deletes any existing uploaded files for a beat (e.g., beat-0.mp4, beat-0.png) before saving a replacement.
 */
export async function deleteExistingBeatUploads(
  videoId: string,
  beatIndex: number,
): Promise<void> {
  if (!videoId || !/^[a-zA-Z0-9_-]+$/.test(videoId) || !Number.isInteger(beatIndex) || beatIndex < 0) {
    return;
  }

  const uploadDir = path.join(process.cwd(), 'storage', 'uploads', videoId);
  try {
    const files = await fs.readdir(uploadDir);
    const prefix = `beat-${beatIndex}.`;
    for (const file of files) {
      if (file.startsWith(prefix)) {
        await fs.unlink(path.join(uploadDir, file)).catch(() => {});
      }
    }
  } catch {
    // Directory might not exist yet; safe to ignore
  }
}

/**
 * Finds an existing uploaded file for a given beat in storage/uploads/<videoId>/beat-<beatIndex>.<ext>.
 */
export async function findExistingBeatUpload(
  videoId: string,
  beatIndex: number,
): Promise<{ filePath: string; ext: string; isVideo: boolean } | null> {
  if (!videoId || !/^[a-zA-Z0-9_-]+$/.test(videoId) || !Number.isInteger(beatIndex) || beatIndex < 0) {
    return null;
  }

  const uploadDir = path.join(process.cwd(), 'storage', 'uploads', videoId);
  try {
    const files = await fs.readdir(uploadDir);
    const prefix = `beat-${beatIndex}.`;
    const matches = files.filter((f) => f.startsWith(prefix));
    if (matches.length === 0) return null;

    if (matches.length === 1) {
      const match = matches[0];
      const ext = path.extname(match).replace(/^\./, '').toLowerCase();
      const filePath = path.join(uploadDir, match);
      const isVideo = ['mp4', 'mov', 'webm'].includes(ext);
      return { filePath, ext, isVideo };
    }

    // If multiple candidates exist for this beat, prioritize the newest file by mtime
    const statsWithMatches = await Promise.all(
      matches.map(async (m) => {
        const fp = path.join(uploadDir, m);
        const st = await fs.stat(fp).catch(() => null);
        return { match: m, filePath: fp, mtime: st?.mtimeMs ?? 0 };
      }),
    );
    statsWithMatches.sort((a, b) => b.mtime - a.mtime);
    const newest = statsWithMatches[0];
    const ext = path.extname(newest.match).replace(/^\./, '').toLowerCase();
    const isVideo = ['mp4', 'mov', 'webm'].includes(ext);

    return { filePath: newest.filePath, ext, isVideo };
  } catch {
    return null;
  }
}

/**
 * Computes user-facing warnings for an uploaded asset:
 * 1. video shorter than the beat's measured TTS duration (assembly will hold the last frame)
 * 2. non-16:9 aspect ratio
 */
export function computeUploadWarnings(
  probe: MediaProbeInfo,
  ttsDurationMs?: number | null,
): string[] {
  const warnings: string[] = [];

  // Warning 1: video shorter than beat's measured TTS duration
  if (probe.isVideo && ttsDurationMs != null && ttsDurationMs > 0 && probe.durationMs < ttsDurationMs) {
    warnings.push(
      `Video duration (${(probe.durationMs / 1000).toFixed(1)}s) is shorter than beat's measured TTS duration (${(ttsDurationMs / 1000).toFixed(1)}s). Assembly will hold the last frame.`,
    );
  }

  // Warning 2: non-16:9 aspect ratio
  const targetRatio = 16 / 9;
  if (Math.abs(probe.aspectRatio - targetRatio) > 0.05) {
    warnings.push(
      `Asset aspect ratio (${probe.width}x${probe.height}, ratio ${probe.aspectRatio.toFixed(2)}) is not 16:9. Assembly will letterbox/pillarbox to 1920x1080.`,
    );
  }

  return warnings;
}

/**
 * Hard-invalidates any stale assembly clips and job units for a specific beat.
 * Called whenever a visual is replaced, uploaded, or swapped so prior rendered scene clips
 * can never accidentally be reused.
 */
export async function invalidateBeatAssemblyCache(
  supabase: SupabaseClient,
  videoId: string,
  beatIndex: number,
): Promise<void> {
  if (!videoId || !Number.isInteger(beatIndex) || beatIndex < 0) return;

  try {
    const { data: jobs } = await supabase
      .from('yt_jobs')
      .select('id')
      .eq('video_id', videoId);

    if (jobs && jobs.length > 0) {
      const jobIds = jobs.map((j: { id: string }) => j.id);
      await supabase
        .from('yt_job_units')
        .delete()
        .in('job_id', jobIds)
        .eq('stage', 'assembly')
        .eq('unit_index', beatIndex);

      for (const j of jobs) {
        const staleClipPath = path.join(
          process.cwd(),
          'storage',
          'jobs',
          j.id,
          'temp_assembly',
          `scene_${beatIndex}.mp4`,
        );
        await fs.unlink(staleClipPath).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[CacheInvalidation] Warning: failed to invalidate beat assembly cache:', err);
  }
}
