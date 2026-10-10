/**
 * Batch Visual Mapping Utilities
 * Intelligently extracts beat indices from uploaded filenames, maps files
 * sequentially or by pattern, and tracks batch upload lifecycle state.
 */

export interface BatchFileItem {
  id: string;
  file: File;
  fileName: string;
  fileSize: number;
  mimeType: string;
  assignedBeatIndex: number | null; // 0-based beat index
  licenseType: string;
  sourceNote: string;
  attributionText: string;
  status: 'pending' | 'uploading' | 'done' | 'error';
  uploadProgress: number; // 0 to 100
  error?: string;
  warnings?: string[];
  previewUrl?: string;
}

export interface AutoMapOptions {
  mode?: 'smart' | 'sequential';
  startBeat?: number; // 0-based starting beat
  indexBase?: 'auto' | 0 | 1;
  defaultLicense?: string;
  existingAssetBeatIndices?: Set<number>;
  skipExisting?: boolean;
}

/**
 * Extracts candidate integer number from filename.
 * Supports patterns:
 * - beat-0, beat_1, beat 2, b0
 * - scene-1, scene_02
 * - shot-1, shot_2
 * - 01_intro.mp4, 02.png, clip-03.jpg
 * - video_10.mp4
 */
export function extractCandidateNumber(filename: string): {
  number: number;
  pattern: 'beat' | 'scene' | 'shot' | 'prefix' | 'suffix' | 'general' | null;
} | null {
  const baseName = filename.replace(/\.[^/.]+$/, '').trim();

  // 1. Explicit "beat" pattern (e.g. beat-0, beat_1, beat2)
  const beatMatch = baseName.match(/(?:^|[^a-zA-Z0-9])(?:beat|b)[-_ ]?(\d+)(?:[^a-zA-Z0-9]|$)/i);
  if (beatMatch) {
    return { number: parseInt(beatMatch[1], 10), pattern: 'beat' };
  }

  // 2. Explicit "scene" pattern (e.g. scene-1, scene_2)
  const sceneMatch = baseName.match(/(?:^|[^a-zA-Z0-9])(?:scene|sc)[-_ ]?(\d+)(?:[^a-zA-Z0-9]|$)/i);
  if (sceneMatch) {
    return { number: parseInt(sceneMatch[1], 10), pattern: 'scene' };
  }

  // 3. Explicit "shot" pattern (e.g. shot-1, shot_2)
  const shotMatch = baseName.match(/(?:^|[^a-zA-Z0-9])shot[-_ ]?(\d+)(?:[^a-zA-Z0-9]|$)/i);
  if (shotMatch) {
    return { number: parseInt(shotMatch[1], 10), pattern: 'shot' };
  }

  // 4. Leading numeric prefix (e.g. "01_forest.mp4", "02-intro.jpg", "3.png")
  const prefixMatch = baseName.match(/^(\d+)[-_ .]/);
  if (prefixMatch) {
    return { number: parseInt(prefixMatch[1], 10), pattern: 'prefix' };
  }

  // 5. Trailing numeric suffix (e.g. "forest_01.mp4", "render-2.png")
  const suffixMatch = baseName.match(/[-_ .](\d+)$/);
  if (suffixMatch) {
    return { number: parseInt(suffixMatch[1], 10), pattern: 'suffix' };
  }

  // 6. Solitary number (e.g. "1.mp4", "002.png")
  if (/^\d+$/.test(baseName)) {
    return { number: parseInt(baseName, 10), pattern: 'general' };
  }

  // 7. Any first number in string
  const anyNumMatch = baseName.match(/\b(\d+)\b/);
  if (anyNumMatch) {
    return { number: parseInt(anyNumMatch[1], 10), pattern: 'general' };
  }

  return null;
}

/**
 * Extracts and maps beat index (0-based) from filename given total beats count.
 */
export function extractBeatIndexFromFilename(
  filename: string,
  totalBeats: number,
  indexBase: 'auto' | 0 | 1 = 'auto',
): number | null {
  const candidate = extractCandidateNumber(filename);
  if (!candidate) return null;

  const num = candidate.number;

  if (indexBase === 0) {
    return num >= 0 && num < totalBeats ? num : null;
  }

  if (indexBase === 1) {
    const idx0 = num - 1;
    return idx0 >= 0 && idx0 < totalBeats ? idx0 : null;
  }

  // 'auto' mode heuristic:
  // If number is exactly 0, it's definitely 0-based.
  if (num === 0) {
    return 0 < totalBeats ? 0 : null;
  }

  // If number equals totalBeats (e.g. num = 10 when totalBeats = 10), it's 1-based (beat index 9).
  if (num === totalBeats) {
    return totalBeats - 1;
  }

  // If candidate pattern is "scene" or "shot", standard human convention is 1-based.
  if (candidate.pattern === 'scene' || candidate.pattern === 'shot') {
    const idx0 = num - 1;
    if (idx0 >= 0 && idx0 < totalBeats) return idx0;
  }

  // If candidate pattern is "beat" and num is within 0..totalBeats-1,
  // we check if num < totalBeats: assume 0-based if < totalBeats, or 1-based if num === totalBeats
  if (candidate.pattern === 'beat') {
    if (num < totalBeats) return num;
    if (num === totalBeats) return totalBeats - 1;
  }

  // Default within bounds: if num < totalBeats, use num.
  if (num < totalBeats) {
    return num;
  }

  // If num - 1 is within bounds, map as 1-based.
  if (num - 1 < totalBeats && num - 1 >= 0) {
    return num - 1;
  }

  return null;
}

/**
 * Maps a list of Files to beat indices based on filename heuristics or sequential order.
 */
export function autoMapFilesToBeats(
  files: File[],
  totalBeats: number,
  options: AutoMapOptions = {},
): BatchFileItem[] {
  const {
    mode = 'smart',
    startBeat = 0,
    indexBase = 'auto',
    defaultLicense = 'own_work',
    existingAssetBeatIndices = new Set<number>(),
    skipExisting = false,
  } = options;

  const items: BatchFileItem[] = [];
  const assignedBeats = new Set<number>();

  // If sequential mode
  if (mode === 'sequential') {
    let currentBeat = Math.max(0, startBeat);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let beatToAssign: number | null = null;

      while (currentBeat < totalBeats) {
        if (skipExisting && existingAssetBeatIndices.has(currentBeat)) {
          currentBeat++;
          continue;
        }
        beatToAssign = currentBeat;
        currentBeat++;
        break;
      }

      items.push({
        id: `file-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        assignedBeatIndex: beatToAssign,
        licenseType: defaultLicense,
        sourceNote: '',
        attributionText: '',
        status: 'pending',
        uploadProgress: 0,
      });
    }

    return items;
  }

  // 'smart' mode: filename detection first
  const unmappedFiles: Array<{ file: File; index: number }> = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const detectedIndex = extractBeatIndexFromFilename(file.name, totalBeats, indexBase);

    if (
      detectedIndex !== null &&
      detectedIndex >= 0 &&
      detectedIndex < totalBeats &&
      !assignedBeats.has(detectedIndex)
    ) {
      assignedBeats.add(detectedIndex);
      items.push({
        id: `file-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        assignedBeatIndex: detectedIndex,
        licenseType: defaultLicense,
        sourceNote: '',
        attributionText: '',
        status: 'pending',
        uploadProgress: 0,
      });
    } else {
      unmappedFiles.push({ file, index: i });
    }
  }

  // For files where filename detection was ambiguous or collided,
  // find first unassigned beat
  let nextAvailableBeat = Math.max(0, startBeat);

  for (const { file, index } of unmappedFiles) {
    let beatToAssign: number | null = null;

    while (nextAvailableBeat < totalBeats) {
      if (assignedBeats.has(nextAvailableBeat)) {
        nextAvailableBeat++;
        continue;
      }
      if (skipExisting && existingAssetBeatIndices.has(nextAvailableBeat)) {
        nextAvailableBeat++;
        continue;
      }
      beatToAssign = nextAvailableBeat;
      assignedBeats.add(beatToAssign);
      nextAvailableBeat++;
      break;
    }

    items.push({
      id: `file-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      file,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      assignedBeatIndex: beatToAssign,
      licenseType: defaultLicense,
      sourceNote: '',
      attributionText: '',
      status: 'pending',
      uploadProgress: 0,
    });
  }

  // Sort items by assignedBeatIndex ascending for clean presentation
  items.sort((a, b) => {
    if (a.assignedBeatIndex === null) return 1;
    if (b.assignedBeatIndex === null) return -1;
    return a.assignedBeatIndex - b.assignedBeatIndex;
  });

  return items;
}
