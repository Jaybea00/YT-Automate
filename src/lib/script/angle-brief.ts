/** Angles as the new-video page uses them (client-safe; the LLM call is in angles.ts). */

export const ANGLE_KINDS = ['curiosity', 'stakes', 'story', 'mystery', 'contrarian', 'number', 'how', 'versus'] as const;

export interface VideoAngle {
  /** The title it would be packaged with. */
  title: string;
  /** The opening line or moment. */
  hook: string;
  /** What makes this angle different, in one sentence. */
  angle: string;
  kind: (typeof ANGLE_KINDS)[number];
  /** The one image that would stop the scroll. */
  thumbnail: string;
  /** 2-4 words on the thumbnail, or "". */
  thumbnail_text: string;
  /** Why viewers would click (and stay), in one sentence. */
  why: string;
}

/** The brief a chosen angle starts the video with (editable on the new-video page). */
export function briefForAngle(angle: VideoAngle): string {
  return [
    `Angle: ${angle.angle}`,
    angle.hook ? `Open with: "${angle.hook}"` : '',
    `Title idea: ${angle.title}`,
    angle.thumbnail ? `Thumbnail idea: ${angle.thumbnail}${angle.thumbnail_text ? ` with the text "${angle.thumbnail_text}"` : ''}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

