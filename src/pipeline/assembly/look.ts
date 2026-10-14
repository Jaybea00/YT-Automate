/**
 * One film, one look: a gentle grade per video style, so archive photos, stock clips and motion
 * graphics read as one piece. Applied once at mastering, before captions (captions stay clean).
 * Grades are deliberately mild: they unify, they don't stylise.
 *
 * Built from cheap filters that work on the YUV planes directly (eq, and a lookup-table tint on
 * the colour planes): on this class of machine colorbalance (an RGB round trip), vignette and
 * film grain each multiplied the mastering time several times over, for little visible gain.
 */

const LOOKS: Record<string, string> = {
  // Slightly muted, warm
  documentary: "eq=contrast=1.05:saturation=0.9:gamma=0.98,lutyuv=u='val-2':v='val+3'",
  // Clean and a touch warm
  vox: "eq=contrast=1.03:saturation=1.04,lutyuv=u='val-1':v='val+1'",
  // Cool and crisp
  tech: "eq=contrast=1.06:saturation=0.97,lutyuv=u='val+3':v='val-1'",
  // Neutral and crisp
  business: "eq=contrast=1.04,lutyuv=u='val+1'",
  // Warmer, a little richer
  warm: "eq=contrast=1.03:saturation=1.06,lutyuv=u='val-3':v='val+3'",
  // Desaturated, cool, harder contrast
  noir: "eq=contrast=1.1:saturation=0.75:gamma=0.95,lutyuv=u='val+3':v='val-1'",
};

/** The grade filter for a theme (see motion/theme.ts names), or null when the look is off. */
export function lookFilter(themeName: string, setting: unknown = 'auto'): string | null {
  if (setting === 'off') return null;
  return LOOKS[themeName] ?? null;
}

export const LOOK_THEMES = Object.keys(LOOKS);
