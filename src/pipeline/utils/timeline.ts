/**
 * Where everything sits in the finished video, saved by assembly as script_json.timeline.
 * Subtitles, thumbnails and Shorts read it rather than re-deriving timing from voice lengths
 * (which ignores the lead-ins and pauses between beats).
 */
export interface TimelineBeat {
  index: number;
  /** Where the beat's scene starts (its lead-in, then the voice). */
  sceneStartMs: number;
  sceneMs: number;
  /** Where the narration starts. */
  voiceStartMs: number;
  voiceMs: number | null;
  /** The beat's narration audio (its word-timing sidecar sits beside it). */
  audioPath: string | null;
  /** The composed track, whose shot list says what is on screen. */
  trackPath: string | null;
  /** The beat's finished scene (picture with its voice), as joined into the video. */
  sceneClipPath?: string | null;
}

export interface VideoTimeline {
  version: 1;
  renderedAt: string;
  totalMs: number;
  beats: TimelineBeat[];
  /** The music and the effects on their own, for editing elsewhere (DaVinci Resolve). */
  stems?: { music?: string | null; sfx?: string | null };
  /** Which beats this render built afresh; every other beat reused its scene from an earlier render. */
  rebuiltBeats?: number[];
}

export function readTimeline(scriptJson: unknown): VideoTimeline | null {
  const t = (scriptJson as { timeline?: VideoTimeline } | null)?.timeline;
  return t?.version === 1 && Array.isArray(t.beats) && t.beats.length > 0 ? t : null;
}
