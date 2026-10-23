import { prepareRealSound, type RealSoundId } from './real-sfx';
import type { SoundId } from './sfx';
import type { SoundCue } from './sound-design';

/**
 * Per-style sound palettes: the on-screen effects (a stat landing, a newspaper appearing, a map
 * pin) played with real recordings that suit the style: a typewriter key and paper in History, a
 * dark boom in Mystery, clean UI clicks in Tech. Any effect without a recording keeps its
 * synthesised sound, so a palette never leaves a gap.
 */

export type Palette = Partial<Record<SoundId, RealSoundId>>;

const DOCUMENTARY: Palette = { whoosh: 'whoosh_soft', swoosh: 'whoosh_dark', impact: 'cinematic_boom', riser: 'tension_riser', paper: 'paper_rustle' };

const PALETTES: Record<string, Palette> = {
  history: { ...DOCUMENTARY, key: 'typewriter_key', paper: 'paper_rustle', tick: 'typewriter_key', chime: 'bell_ding' },
  cinematic: DOCUMENTARY,
  story_driven: DOCUMENTARY,
  mystery: { ...DOCUMENTARY, impact: 'cinematic_boom', key: 'typewriter_key', paper: 'page_turn' },
  true_crime_pov: { ...DOCUMENTARY, key: 'typewriter_key', paper: 'page_turn', tick: 'stamp' },
  sport: { whoosh: 'whoosh_soft', swoosh: 'whoosh_soft', impact: 'ball_kick', chime: 'whistle', riser: 'tension_riser' },
  tech: { whoosh: 'whoosh_soft', key: 'keyboard_key', tick: 'ui_click', ping: 'ui_ping', chime: 'ui_ping' },
  tech_review: { whoosh: 'whoosh_soft', key: 'keyboard_key', tick: 'ui_click', ping: 'ui_ping', chime: 'ui_ping' },
  finance: { whoosh: 'whoosh_soft', tick: 'ui_click', ping: 'ui_ping', chime: 'cash_register', impact: 'cinematic_boom' },
  modernmba: { whoosh: 'whoosh_soft', tick: 'ui_click', ping: 'ui_ping', paper: 'paper_rustle' },
  space_science: { whoosh: 'whoosh_dark', swoosh: 'whoosh_dark', impact: 'cinematic_boom', riser: 'tension_riser', ping: 'ui_ping' },
  vox_explainer: { whoosh: 'whoosh_soft', paper: 'paper_rustle', key: 'typewriter_key', tick: 'ui_click' },
  car: { whoosh: 'whoosh_soft', impact: 'cinematic_boom', tick: 'ui_click' },
  listicle: { whoosh: 'whoosh_soft', tick: 'ui_click', chime: 'bell_ding' },
  comparison: { whoosh: 'whoosh_soft', tick: 'ui_click' },
  eli5: { whoosh: 'whoosh_soft', chime: 'bell_ding', ping: 'ui_ping' },
};

export function paletteFor(style: string | null | undefined): Palette {
  return (style && PALETTES[style]) || {};
}

/**
 * Gives each on-screen effect its style's recording where one is available. `prepare` is
 * injectable for tests; recordings are prepared once each.
 */
export async function applyPalette(
  cues: SoundCue[],
  style: string | null | undefined,
  prepare: (id: RealSoundId) => Promise<string | null> = prepareRealSound,
): Promise<SoundCue[]> {
  const palette = paletteFor(style);
  const needed = [...new Set(cues.filter((c) => !c.file && c.sound in palette).map((c) => palette[c.sound as SoundId]!))];
  if (needed.length === 0) return cues;
  const files = new Map<RealSoundId, string>();
  for (const id of needed) {
    const file = await prepare(id).catch(() => null);
    if (file) files.set(id, file);
  }
  return cues.map((c) => {
    const real = c.file ? undefined : palette[c.sound as SoundId];
    const file = real && files.get(real);
    return file ? { ...c, sound: `real:${real}` as const, file } : c;
  });
}
