/**
 * Visual identity for generated graphics, matched to the video's style and kept consistent
 * within a video. Fonts are ones installed with Windows (with web-safe fallbacks), so rendering
 * never depends on downloading fonts.
 */
export interface MotionTheme {
  name: string;
  background: string;
  /** Subtle texture/vignette layered over the background (CSS background value). */
  backgroundOverlay: string;
  surface: string;
  text: string;
  muted: string;
  /** Fills: bars, rules, highlighter strokes, chart lines. */
  accent: string;
  /** Accent for TEXT on the background; differs from `accent` where that would be low-contrast. */
  accentText: string;
  accent2: string;
  /** Series colors for charts, in order. */
  series: string[];
  headingFont: string;
  bodyFont: string;
  numberFont: string;
  /** Corner radius for cards, in px. */
  radius: number;
  /** Maps: land fill, borders, water. */
  map: { water: string; land: string; border: string; highlight: string };
}

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
const CONDENSED = 'Bahnschrift, "Arial Narrow", "Segoe UI", sans-serif';

const DOCUMENTARY: MotionTheme = {
  name: 'documentary',
  background: '#0c0d10',
  backgroundOverlay: 'radial-gradient(ellipse at center, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.55) 100%)',
  surface: '#16181d',
  text: '#f2efe8',
  muted: '#9a968c',
  accent: '#e3b04b',
  accentText: '#e3b04b',
  accent2: '#c0563b',
  series: ['#e3b04b', '#c0563b', '#6f9fb8', '#8db07a'],
  headingFont: SERIF,
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 6,
  map: { water: '#0c0d10', land: '#24272e', border: '#3a3e47', highlight: '#e3b04b' },
};

const VOX: MotionTheme = {
  name: 'vox',
  background: '#f4efe4',
  backgroundOverlay: 'radial-gradient(ellipse at center, rgba(255,255,255,0.35) 0%, rgba(120,100,70,0.12) 100%)',
  surface: '#fffaf0',
  text: '#1b1b1b',
  muted: '#6d665b',
  accent: '#f2c200',
  accentText: '#c8381a',
  accent2: '#e2512e',
  series: ['#e2512e', '#1b1b1b', '#3d7ea6', '#f2c200'],
  headingFont: SERIF,
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 2,
  map: { water: '#dfe8ea', land: '#f4efe4', border: '#b9b1a1', highlight: '#e2512e' },
};

const TECH: MotionTheme = {
  name: 'tech',
  background: '#07080c',
  backgroundOverlay: 'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px) 0 0/100% 48px, linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px) 0 0/48px 100%',
  surface: '#10131b',
  text: '#eef2ff',
  muted: '#8590a8',
  accent: '#38e1c6',
  accentText: '#38e1c6',
  accent2: '#7c5cff',
  series: ['#38e1c6', '#7c5cff', '#ff6b9a', '#ffd166'],
  headingFont: SANS,
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 14,
  map: { water: '#07080c', land: '#151a26', border: '#283147', highlight: '#38e1c6' },
};

const BUSINESS: MotionTheme = {
  name: 'business',
  background: '#0e1726',
  backgroundOverlay: 'radial-gradient(ellipse at 30% 20%, rgba(80,140,255,0.12) 0%, rgba(0,0,0,0.4) 100%)',
  surface: '#15223a',
  text: '#f3f6fb',
  muted: '#93a3bd',
  accent: '#4fb3ff',
  accentText: '#4fb3ff',
  accent2: '#2ecc8f',
  series: ['#4fb3ff', '#2ecc8f', '#f5a524', '#e5484d'],
  headingFont: SANS,
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 10,
  map: { water: '#0e1726', land: '#1d2c47', border: '#2f4366', highlight: '#4fb3ff' },
};

const WARM: MotionTheme = {
  name: 'warm',
  background: '#fdf6ec',
  backgroundOverlay: 'radial-gradient(ellipse at center, rgba(255,255,255,0.5) 0%, rgba(240,200,150,0.15) 100%)',
  surface: '#ffffff',
  text: '#2b2118',
  muted: '#7a6a58',
  accent: '#ff8a3d',
  accentText: '#b8500f',
  accent2: '#3fa7a0',
  series: ['#ff8a3d', '#3fa7a0', '#7a5cff', '#e9c46a'],
  headingFont: '"Segoe UI Semibold", "Segoe UI", sans-serif',
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 18,
  map: { water: '#dff1f3', land: '#fdf6ec', border: '#d9c7ae', highlight: '#ff8a3d' },
};

const NOIR: MotionTheme = {
  name: 'noir',
  background: '#060606',
  backgroundOverlay: 'radial-gradient(ellipse at center, rgba(120,0,0,0.08) 0%, rgba(0,0,0,0.75) 100%)',
  surface: '#111111',
  text: '#e9e6df',
  muted: '#8a857c',
  accent: '#c8272b',
  accentText: '#e0383c',
  accent2: '#d9d2c3',
  series: ['#c8272b', '#d9d2c3', '#6b6b6b', '#a37c4c'],
  headingFont: SERIF,
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 0,
  map: { water: '#060606', land: '#161616', border: '#2c2c2c', highlight: '#c8272b' },
};

const STYLE_THEMES: Record<string, MotionTheme> = {
  vox_explainer: VOX,
  cinematic: DOCUMENTARY,
  story_driven: DOCUMENTARY,
  tech: TECH,
  modernmba: BUSINESS,
  comparison: BUSINESS,
  listicle: WARM,
  eli5: WARM,
  true_crime_pov: NOIR,
};

export function themeForStyle(style: string | null | undefined): MotionTheme {
  return (style && STYLE_THEMES[style]) || DOCUMENTARY;
}

/** Shared CSS: background with overlay and a gentle film grain for texture. */
export function baseCss(theme: MotionTheme): string {
  return `body{background:${theme.background};color:${theme.text};font-family:${theme.bodyFont}}
.bg{position:absolute;inset:0;background:${theme.backgroundOverlay}}`;
}
