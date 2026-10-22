import { stylePack } from '@/lib/styles/packs';
import { DOCUMENTARY, type MotionTheme } from '@/lib/styles/themes';

/**
 * The graphics theme for a video's style. Themes (colours, fonts, grade) live in
 * src/lib/styles/themes.ts and each style pack picks one.
 */
export type { MotionTheme };

export function themeForStyle(style: string | null | undefined): MotionTheme {
  return stylePack(style)?.theme ?? DOCUMENTARY;
}

/** Shared CSS: background with overlay and a gentle film grain for texture. */
export function baseCss(theme: MotionTheme): string {
  return `body{background:${theme.background};color:${theme.text};font-family:${theme.bodyFont}}
.bg{position:absolute;inset:0;background:${theme.backgroundOverlay}}`;
}
