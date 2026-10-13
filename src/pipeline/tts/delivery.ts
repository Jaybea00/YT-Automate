/**
 * How the narrator should sound for each video style. Sent to voices that accept
 * natural-language direction (Gemini); other voices ignore it.
 */
const STYLE_DELIVERY: Record<string, string> = {
  tech: 'Fast, crisp and confident, with dry wit; like a sharp tech YouTuber talking to developers.',
  cinematic: 'Measured, atmospheric documentary narration with gravitas; let key lines breathe.',
  modernmba: 'Clear, confident business analyst; steady pace, lean on the numbers.',
  listicle: 'Energetic and upbeat countdown host; punchy, quick rhythm.',
  story_driven: 'Warm, engaging storyteller building tension; slow down for turning points.',
  comparison: 'Even-handed and analytical, then decisive for the verdict.',
  eli5: 'Warm, friendly and patient, like explaining to a curious friend; never condescending.',
  true_crime_pov: 'Low, tense and suspenseful; deliberate pacing with quiet dread.',
  vox_explainer: 'Curious, conversational explainer; plain-spoken and engaged, as if walking the viewer through evidence.',
};

export function deliveryForStyle(style: string | null | undefined): string | undefined {
  return style ? STYLE_DELIVERY[style] : undefined;
}
