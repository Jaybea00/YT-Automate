/** Native Short types, safe to use in the browser. */

export interface NativeShortIdea {
  id: string;
  title: string;
  /** The Short's exact first line. */
  hook: string;
  /** 2-6 words shown at the top of the vertical frame. */
  hook_banner: string;
  angle: string;
  promise: string;
  /** Beats of the long video the Short draws on. */
  source_beats: number[];
  /** Set once the Short's mini video has been created. */
  video_id?: string;
}

export interface NativeShorts {
  generatedAt: string;
  ideas: NativeShortIdea[];
}
