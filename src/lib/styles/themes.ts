/**
 * Visual identity for generated graphics, matched to the video's style and kept consistent
 * within a video. Fonts are ones installed with Windows (with web-safe fallbacks), so rendering
 * never depends on downloading fonts. Each theme also carries its colour grade for mastering.
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
  /**
   * The master's colour grade (an ffmpeg filter chain), applied once at mastering. Mild by
   * design: it unifies archive, stock and graphics; it doesn't stylise. Built from cheap
   * YUV-plane filters (eq, lutyuv); see assembly/look.ts.
   */
  grade: string;
}

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
const CONDENSED = 'Bahnschrift, "Arial Narrow", "Segoe UI", sans-serif';

export const DOCUMENTARY: MotionTheme = {
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
  // Slightly muted, warm
  grade: "eq=contrast=1.05:saturation=0.9:gamma=0.98,lutyuv=u='val-2':v='val+3'",
};

export const VOX: MotionTheme = {
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
  // Clean and a touch warm
  grade: "eq=contrast=1.03:saturation=1.04,lutyuv=u='val-1':v='val+1'",
};

export const TECH: MotionTheme = {
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
  // Cool and crisp
  grade: "eq=contrast=1.06:saturation=0.97,lutyuv=u='val+3':v='val-1'",
};

export const BUSINESS: MotionTheme = {
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
  // Neutral and crisp
  grade: "eq=contrast=1.04,lutyuv=u='val+1'",
};

export const WARM: MotionTheme = {
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
  // Warmer, a little richer
  grade: "eq=contrast=1.03:saturation=1.06,lutyuv=u='val-3':v='val+3'",
};

export const NOIR: MotionTheme = {
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
  // Desaturated, cool, harder contrast
  grade: "eq=contrast=1.1:saturation=0.75:gamma=0.95,lutyuv=u='val+3':v='val-1'",
};

// --------------------------------------------------------------------------
// Niche themes
// --------------------------------------------------------------------------

/** Car culture: graphite and racing orange, condensed type like a spec sheet. */
export const AUTOMOTIVE: MotionTheme = {
  name: 'automotive',
  background: '#0a0b0d',
  backgroundOverlay: 'radial-gradient(ellipse at 70% 25%, rgba(255,90,40,0.10) 0%, rgba(0,0,0,0.6) 100%)',
  surface: '#15171b',
  text: '#f4f4f2',
  muted: '#8b8f97',
  accent: '#ff4d1f',
  accentText: '#ff6a3d',
  accent2: '#c9ced6',
  series: ['#ff4d1f', '#c9ced6', '#3fa9f5', '#ffc53d'],
  headingFont: CONDENSED,
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 4,
  map: { water: '#0a0b0d', land: '#1b1d22', border: '#30333a', highlight: '#ff4d1f' },
  // Punchy contrast, a hint cool
  grade: "eq=contrast=1.08:saturation=1.04,lutyuv=u='val+2'",
};

/** Sport: floodlit navy with electric lime, heavy scoreboard type. */
export const STADIUM: MotionTheme = {
  name: 'stadium',
  background: '#070b14',
  backgroundOverlay: 'radial-gradient(ellipse at 50% 0%, rgba(120,170,255,0.16) 0%, rgba(0,0,0,0.6) 100%)',
  surface: '#101828',
  text: '#ffffff',
  muted: '#8e9bb3',
  accent: '#d4ff3a',
  accentText: '#d4ff3a',
  accent2: '#2f80ff',
  series: ['#d4ff3a', '#2f80ff', '#ff4d6d', '#ffffff'],
  headingFont: '"Arial Black", Impact, Bahnschrift, sans-serif',
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 8,
  map: { water: '#070b14', land: '#16213a', border: '#26365a', highlight: '#d4ff3a' },
  // Vivid and contrasty, like a broadcast
  grade: 'eq=contrast=1.08:saturation=1.1',
};

/** Finance: deep green-black, money green and gold, clean figures. */
export const MONEY: MotionTheme = {
  name: 'money',
  background: '#08120d',
  backgroundOverlay: 'radial-gradient(ellipse at 30% 20%, rgba(47,208,122,0.10) 0%, rgba(0,0,0,0.5) 100%)',
  surface: '#0f1d16',
  text: '#eef7f1',
  muted: '#8fa89a',
  accent: '#2fd07a',
  accentText: '#2fd07a',
  accent2: '#e3b04b',
  series: ['#2fd07a', '#e3b04b', '#4fb3ff', '#e5484d'],
  headingFont: SANS,
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 10,
  map: { water: '#08120d', land: '#14271d', border: '#21402f', highlight: '#2fd07a' },
  // Neutral and crisp
  grade: "eq=contrast=1.04:saturation=0.98,lutyuv=u='val+1':v='val-1'",
};

/** Space and science: deep space with a faint starfield, violet and cyan. */
export const COSMOS: MotionTheme = {
  name: 'cosmos',
  background: '#04060d',
  backgroundOverlay:
    'radial-gradient(1px 1px at 20% 30%, rgba(255,255,255,0.65) 50%, transparent 51%) 0 0/180px 180px, ' +
    'radial-gradient(1px 1px at 70% 60%, rgba(255,255,255,0.5) 50%, transparent 51%) 0 0/240px 240px, ' +
    'radial-gradient(1.4px 1.4px at 45% 80%, rgba(255,255,255,0.45) 50%, transparent 51%) 0 0/310px 310px, ' +
    'radial-gradient(ellipse at 60% 40%, rgba(90,80,200,0.16) 0%, rgba(0,0,0,0.7) 100%)',
  surface: '#0c1020',
  text: '#eef1ff',
  muted: '#8a90b0',
  accent: '#8f7bff',
  accentText: '#a99bff',
  accent2: '#3ee0ff',
  series: ['#8f7bff', '#3ee0ff', '#ff7ab6', '#ffd166'],
  headingFont: SANS,
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 12,
  map: { water: '#04060d', land: '#141a33', border: '#252d52', highlight: '#3ee0ff' },
  // Cool and clear
  grade: "eq=contrast=1.06,lutyuv=u='val+3':v='val-2'",
};

/** Tech reviews: clean studio white, black type, one red accent. */
export const REVIEW: MotionTheme = {
  name: 'review',
  background: '#f3f4f6',
  backgroundOverlay: 'radial-gradient(ellipse at center, rgba(255,255,255,0.6) 0%, rgba(0,0,0,0.05) 100%)',
  surface: '#ffffff',
  text: '#111318',
  muted: '#646b78',
  accent: '#ff2d2d',
  accentText: '#d91f1f',
  accent2: '#111318',
  series: ['#ff2d2d', '#111318', '#2f80ff', '#9aa3b2'],
  headingFont: SANS,
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 16,
  map: { water: '#dde3ea', land: '#f3f4f6', border: '#c2c8d0', highlight: '#ff2d2d' },
  // Clean, true colours
  grade: 'eq=contrast=1.03:saturation=1.02',
};

/** History: dark sepia and brass, book-like serif. */
export const HISTORY: MotionTheme = {
  name: 'history',
  background: '#14100b',
  backgroundOverlay: 'radial-gradient(ellipse at center, rgba(255,220,160,0.06) 0%, rgba(0,0,0,0.6) 100%)',
  surface: '#1e1811',
  text: '#f1e6d0',
  muted: '#a39478',
  accent: '#c9a227',
  accentText: '#d9b441',
  accent2: '#8c3b2a',
  series: ['#c9a227', '#8c3b2a', '#6f8a7a', '#d9cbb0'],
  headingFont: 'Constantia, Georgia, "Times New Roman", serif',
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 3,
  map: { water: '#14100b', land: '#2a2218', border: '#43382a', highlight: '#c9a227' },
  // Warm and a little muted, like old print
  grade: "eq=contrast=1.04:saturation=0.85:gamma=0.98,lutyuv=u='val-3':v='val+4'",
};

/** Mysteries: fog-teal darkness, pale cyan accent. */
export const MYSTERY: MotionTheme = {
  name: 'mystery',
  background: '#050c0d',
  backgroundOverlay: 'radial-gradient(ellipse at 50% 40%, rgba(80,160,150,0.10) 0%, rgba(0,0,0,0.75) 100%)',
  surface: '#0d1718',
  text: '#e3efec',
  muted: '#7f9a96',
  accent: '#5fd1c1',
  accentText: '#72dccd',
  accent2: '#c9b27a',
  series: ['#5fd1c1', '#c9b27a', '#8a6fd1', '#e3efec'],
  headingFont: SERIF,
  bodyFont: SANS,
  numberFont: CONDENSED,
  radius: 2,
  map: { water: '#050c0d', land: '#132022', border: '#223538', highlight: '#5fd1c1' },
  // Cool, desaturated, a little harder
  grade: "eq=contrast=1.07:saturation=0.8:gamma=0.96,lutyuv=u='val+3':v='val-2'",
};

export const ALL_THEMES: MotionTheme[] = [DOCUMENTARY, VOX, TECH, BUSINESS, WARM, NOIR, AUTOMOTIVE, STADIUM, MONEY, COSMOS, REVIEW, HISTORY, MYSTERY];
