import { NextResponse } from 'next/server';
import { CAPTION_PRESETS } from '@/pipeline/assembly/captions';
import { MOODS } from '@/pipeline/assembly/music-library';
import { allFormats, allNiches, AUDIENCES, LEGACY_SETUPS, LOOKS } from '@/lib/styles/compose';
import { loadStyleLibrary, SIGNATURE_SHOTS } from '@/lib/styles/library';
import { STYLE_PACKS, type StylePack } from '@/lib/styles/packs';
import { ALL_THEMES } from '@/lib/styles/themes';

/**
 * Everything the new-video and packs pages pick from: formats and niches (built in and the
 * creator's own), looks, audiences, saved writing voices, and the options a custom pack can use.
 */
export async function GET() {
  const library = await loadStyleLibrary();
  return NextResponse.json({
    formats: allFormats(library),
    niches: allNiches(library),
    looks: LOOKS,
    audiences: AUDIENCES,
    voices: library.voices,
    legacy: LEGACY_SETUPS,
    options: {
      themes: ALL_THEMES.map((t) => ({ name: t.name, background: t.background, surface: t.surface, text: t.text, accent: t.accent, accent2: t.accent2 })),
      moods: MOODS,
      captionPresets: CAPTION_PRESETS,
      signatureShots: SIGNATURE_SHOTS,
      baseStyles: (Object.values(STYLE_PACKS) as StylePack[])
        .filter((p) => !p.drawn)
        .map((p) => ({ id: p.id, name: p.name })),
    },
  });
}
