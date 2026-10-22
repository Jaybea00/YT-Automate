/**
 * One film, one look: a gentle grade per video style, so archive photos, stock clips and motion
 * graphics read as one piece. Applied once at mastering, before captions (captions stay clean).
 * Grades are deliberately mild: they unify, they don't stylise.
 *
 * Built from cheap filters that work on the YUV planes directly (eq, and a lookup-table tint on
 * the colour planes): on this class of machine colorbalance (an RGB round trip), vignette and
 * film grain each multiplied the mastering time several times over, for little visible gain.
 */

import { ALL_THEMES } from '@/lib/styles/themes';

/** Grades live with their themes (src/lib/styles/themes.ts), keyed here by theme name. */
const LOOKS: Record<string, string> = Object.fromEntries(ALL_THEMES.map((t) => [t.name, t.grade]));

/** The grade filter for a theme (see motion/theme.ts names), or null when the look is off. */
export function lookFilter(themeName: string, setting: unknown = 'auto'): string | null {
  if (setting === 'off') return null;
  return LOOKS[themeName] ?? null;
}

export const LOOK_THEMES = Object.keys(LOOKS);
