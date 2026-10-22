import { stylePack } from '@/lib/styles/packs';

/**
 * How the narrator should sound for each video style (from its style pack). Sent to voices that
 * accept natural-language direction (Gemini); other voices ignore it.
 */
export function deliveryForStyle(style: string | null | undefined): string | undefined {
  return stylePack(style)?.delivery;
}
