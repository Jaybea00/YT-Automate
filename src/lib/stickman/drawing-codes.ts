/**
 * Drawing codes for stickman videos: every drawing shot has a short code the creator names their
 * file with ("B05_S2.png" = beat 5, shot 2, counted from 1 as the pages show them), so uploads
 * drop straight into place without guessing from the picture.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** "B05_S2" for beat index 4, shot index 1 (indexes from 0, code from 1). */
export function drawingCode(beatIndex: number, shotIndex: number): string {
  return `B${pad(beatIndex + 1)}_S${shotIndex + 1}`;
}

/**
 * The beat and shot (indexes from 0) a file name points to, or null. Accepts the usual ways
 * people type it: "B05_S2.png", "b5-s2.jpg", "B05S2", "beat 5 shot 2", "Beat05_Shot02 v2.png".
 */
export function parseDrawingCode(fileName: string): { beat_index: number; shot_index: number } | null {
  const base = fileName.replace(/\.[a-z0-9]{2,5}$/i, '');
  const match = base.match(/(?:^|[^a-z0-9])b(?:eat)?[\s_-]*0*(\d{1,3})[\s_-]*s(?:hot)?[\s_-]*0*(\d{1,2})(?![0-9])/i)
    ?? base.match(/^b(?:eat)?0*(\d{1,3})[\s_-]*s(?:hot)?0*(\d{1,2})(?![0-9])/i);
  if (!match) return null;
  const beat = Number(match[1]);
  const shot = Number(match[2]);
  if (beat < 1 || shot < 1) return null;
  return { beat_index: beat - 1, shot_index: shot - 1 };
}
