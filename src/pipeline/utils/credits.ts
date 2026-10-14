/**
 * The credits a video's description must carry: the music's credit lines, and every visual
 * whose licence requires attribution (CC BY and CC BY-SA). Public-domain, royalty-free and
 * generated material needs none, so it's left out.
 */

const NEEDS_ATTRIBUTION: Record<string, string> = {
  cc_by: 'CC BY',
  cc_by_sa: 'CC BY-SA',
};

export interface CreditAsset {
  license_type?: string | null;
  attribution_text?: string | null;
}

export function buildDescriptionCredits(musicCredits: string[], assets: CreditAsset[]): string {
  const visuals = new Set<string>();
  for (const asset of assets) {
    const licence = NEEDS_ATTRIBUTION[asset.license_type ?? ''];
    if (!licence || !asset.attribution_text) continue;
    // A composed beat lists every source's attribution, joined with " · "
    for (const part of asset.attribution_text.split(' · ')) {
      const text = part.trim();
      if (text) visuals.add(`${text} (${licence})`);
    }
  }
  const blocks: string[] = [];
  if (musicCredits.length) blocks.push(`Music:\n${musicCredits.join('\n\n')}`);
  if (visuals.size) blocks.push(`Images and footage:\n${[...visuals].map((v) => `• ${v}`).join('\n')}`);
  return blocks.join('\n\n');
}
