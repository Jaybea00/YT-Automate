/**
 * How one beat should be delivered: a mood for the line. Voices that take spoken direction
 * (Gemini TTS) get it as an instruction; every voice gets it as a small change of pace, so the
 * narration rises and falls instead of reading every line the same way. Safe in the browser.
 */

export const DELIVERY_MOODS = ['neutral', 'tense', 'quiet', 'light', 'excited', 'reveal', 'urgent'] as const;
export type DeliveryMood = (typeof DELIVERY_MOODS)[number];

export const isDeliveryMood = (v: unknown): v is DeliveryMood => DELIVERY_MOODS.includes(v as DeliveryMood);

export const MOOD_INFO: Record<DeliveryMood, { label: string; emoji: string; direction: string; speed: number; use: string }> = {
  neutral: { label: 'Neutral', emoji: '⚪', direction: '', speed: 1, use: 'Plain explanation and setup' },
  tense: { label: 'Tense', emoji: '😬', direction: 'Tense and controlled, building suspense, slightly lower.', speed: 0.96, use: 'Build-up before something goes wrong' },
  quiet: { label: 'Quiet', emoji: '🤫', direction: 'Quiet, gentle and sombre, unhurried.', speed: 0.9, use: 'Sad, serious or respectful moments' },
  light: { label: 'Light', emoji: '🙂', direction: 'Light and playful, with a smile in the voice.', speed: 1.04, use: 'Jokes, irony, light asides' },
  excited: { label: 'Excited', emoji: '🤩', direction: 'Energetic and excited, upbeat.', speed: 1.07, use: 'Wins, records, amazing facts' },
  reveal: { label: 'Reveal', emoji: '💡', direction: 'Slow and weighty, landing each word, like revealing the answer.', speed: 0.88, use: 'The payoff, the twist, the big answer' },
  urgent: { label: 'Urgent', emoji: '⏱️', direction: 'Urgent and fast, pressing forward.', speed: 1.1, use: 'Chases, countdowns, things happening fast' },
};

/** The instruction for a direction-taking voice: the video's base delivery plus this line's mood. */
export function directionWithMood(base: string | undefined, mood: DeliveryMood | undefined): string | undefined {
  const extra = mood ? MOOD_INFO[mood].direction : '';
  if (!extra) return base;
  return base ? `${base} For this line: ${extra}` : extra;
}

/** The pace multiple a mood adds (1 when none). */
export const moodSpeed = (mood: DeliveryMood | undefined) => (mood ? MOOD_INFO[mood].speed : 1);
