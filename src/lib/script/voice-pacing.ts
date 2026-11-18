import { stylePack, type NarrationPacing, type StylePack } from '@/lib/styles/packs';

/**
 * A video's own voice pace (script_json.voice_pacing), chosen when voicing starts: how fast the
 * narrator speaks and how long a breath follows each sentence. Without one, the style's pace
 * applies (documentary styles speak slower). Speed works with Kokoro and ElevenLabs; the breath
 * needs the voice's word timings, which Kokoro gives.
 */
export interface VoicePacing {
  speed: number;
  sentencePauseSec: number;
}

export const VOICE_SPEED_OPTIONS = [
  { speed: 1, label: 'Normal', desc: 'The voice as it is' },
  { speed: 0.94, label: 'A little slower', desc: 'About 6% slower' },
  { speed: 0.88, label: 'Calm', desc: 'About 12% slower: reflective scripts' },
  { speed: 0.82, label: 'Slow', desc: 'About 18% slower: very deliberate' },
] as const;

export const SENTENCE_BREATH_SEC = 0.25;

/** A valid pace, or null for anything out of range. */
export function normalizeVoicePacing(value: unknown): VoicePacing | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { speed?: unknown; sentencePauseSec?: unknown };
  const speed = Number(v.speed);
  const pause = Number(v.sentencePauseSec ?? 0);
  if (!(speed >= 0.7 && speed <= 1.2) || !(pause >= 0 && pause <= 1)) return null;
  return { speed: Math.round(speed * 100) / 100, sentencePauseSec: Math.round(pause * 100) / 100 };
}

/**
 * The pace to voice a video at: its own when set (Normal with no breath means the voice as it is,
 * not the style's), else its style's. Undefined means no pacing at all.
 */
export function videoPacing(saved: unknown, style: string | null | undefined, pack?: StylePack): NarrationPacing | VoicePacing | undefined {
  const own = normalizeVoicePacing(saved);
  if (own) return own.speed === 1 && own.sentencePauseSec === 0 ? undefined : own;
  return (pack ?? stylePack(style))?.narration;
}
